'use strict';
// Remote-server panel added to the Windows dashboard when it is served by the Linux server:
// provider login status, the sign-in screen (the server's own browser, via noVNC) and the
// router IP change. Uses the dashboard's own panel/button styles.

(() => {
  const token = () => sessionStorage.getItem('yt-summary-token') || localStorage.getItem('yt-summary-token') || '';
  async function api(path, method = 'GET') {
    const response = await fetch(path, {
      method, headers: { 'X-YT-Token': token() }, cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const panel = el('section', { className: 'panel', id: 'remote-server' });
  const loginList = el('div', { className: 'chips', style: 'margin:6px 0' });
  const loginSummary = el('p', { className: 'muted' }, 'Checking logins…');
  const signIn = el('a', {
    className: 'bookmark', target: '_blank', rel: 'noopener', style: 'display:inline-block;margin:4px 0',
    href: '/vnc/vnc.html?path=vnc/websockify&autoconnect=1&resize=scale&reconnect=1',
  }, 'Open sign-in screen');
  const ipValue = el('b', {}, '…');
  const ipState = el('p', { className: 'muted' });
  const rotate = el('button', {}, 'Change IP now');
  // Always-visible copy of the IP control in the sticky top bar (the panel sits below the
  // video list on phones).
  const topIp = el('button', { id: 'topbar-ip', type: 'button', hidden: true, title: 'Change the public IP' }, 'IP …');
  const signInBlock = el('div', { hidden: true },
    el('div', { className: 'panel-title' }, 'AI site logins'),
    loginList, loginSummary, signIn,
    el('p', { className: 'muted' }, 'Opens the server\'s browser in a new tab. Log in to ChatGPT, Gemini and Claude there once; logins are remembered.'));
  const ipBlock = el('div', { hidden: true },
    el('div', { className: 'panel-title', style: 'margin-top:12px' }, 'Internet address'),
    el('p', {}, 'Public IP: ', ipValue), ipState, rotate,
    el('p', { className: 'muted' }, 'Reconnects the home router for a new public IP. The server (and this page) is offline for about 1–2 minutes, then reconnects by itself. Not allowed while a video is running.'));
  panel.append(el('div', { className: 'panel-title' }, 'Remote server'), signInBlock, ipBlock);

  function mount() {
    const status = document.querySelector('.col .panel');
    if (status) status.after(panel);
    else document.body.append(panel);
    const state = document.querySelector('.topbar #state');
    if (state) state.before(topIp);
  }

  const LOGIN_TEXT = { 'signed-in': '✅', 'signed-out': '❌ not logged in', 'no-tab': '– not opened', loading: '… loading', unknown: '?' };
  async function refreshLogin() {
    try {
      const { status } = await api('/signin/status');
      const names = Object.keys(status);
      loginList.replaceChildren(...names.map((name) => el('span', { className: 'provider-toggle' }, `${name} ${LOGIN_TEXT[status[name]] || status[name]}`)));
      const ready = names.filter((n) => status[n] === 'signed-in').length;
      const checking = names.some((n) => ['loading', 'no-tab', 'unknown'].includes(status[n]));
      if (checking && ready < names.length) {
        loginSummary.textContent = 'Checking logins…';
        loginSummary.style.color = 'var(--muted)';
        setTimeout(refreshLogin, 4000); // pages still opening (e.g. just after a restart)
        return;
      }
      loginSummary.textContent = ready === 0
        ? 'Summaries will fail until you log in to at least one site.'
        : `${ready} of ${names.length} sites logged in.`;
      loginSummary.style.color = ready === 0 ? 'var(--bad)' : ready < names.length ? 'var(--warn)' : 'var(--mint)';
    } catch { /* offline: the dashboard already says so */ }
  }
  signIn.addEventListener('click', () => { api('/signin/open', 'POST').catch(() => {}); });

  let ipTimer;
  async function refreshIp() {
    clearTimeout(ipTimer);
    let next = 30000;
    try {
      const ip = await api('/ip');
      ipValue.textContent = ip.publicIp || (ip.state === 'rotating' ? 'changing…' : 'unknown');
      rotate.disabled = ip.state === 'rotating';
      topIp.disabled = rotate.disabled;
      topIp.textContent = ip.state === 'rotating' ? '🌐 Changing IP…' : `🌐 ${ip.publicIp || 'IP'} · Change IP`;
      if (ip.state === 'rotating') {
        ipState.textContent = `Changing IP (started ${new Date(ip.startedAt).toLocaleTimeString()})…`;
        next = 3000;
      } else if (ip.state === 'done' && ip.result) {
        ipState.textContent = ip.result.changed ? `Changed: ${ip.result.before} → ${ip.result.after}`
          : `Router reconnected but the IP stayed ${ip.result.after}.`;
      } else if (ip.state === 'error') {
        ipState.textContent = `IP change failed: ${ip.error}`;
      }
    } catch {
      ipValue.textContent = 'reconnecting…';
      topIp.textContent = '🌐 Reconnecting…';
      next = 5000;
    }
    ipTimer = setTimeout(refreshIp, next);
  }
  async function changeIp() {
    if (!confirm('Change the public IP now? The server goes offline for about 1–2 minutes.')) return;
    rotate.disabled = true;
    topIp.disabled = true;
    try { await api('/ip/rotate', 'POST'); } catch (error) { ipState.textContent = error.message; alert(error.message); }
    refreshIp();
  }
  rotate.addEventListener('click', changeIp);
  topIp.addEventListener('click', changeIp);

  // ---- Summary viewer: tap a video tile to read its summary and parts here. ----
  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST', headers: { 'X-YT-Token': token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  const viewer = el('dialog', { id: 'summary-viewer' });
  const viewerTitle = el('h2', { dir: 'auto' });
  const viewerMeta = el('p', { className: 'muted' });
  const viewerBody = el('div', { className: 'viewer-body' });
  // Always-visible position rail (phones hide normal scroll bars): the thumb shows where you
  // are, its label names the section and percentage; drag it or tap the rail to move.
  const railLabel = el('span', { className: 'viewer-rail-label' });
  const railThumb = el('div', { className: 'viewer-rail-thumb' });
  const rail = el('div', { className: 'viewer-rail', hidden: true, ariaHidden: 'true' }, railThumb);
  const viewerScroll = el('div', { className: 'viewer-scroll' }, viewerBody, rail, railLabel);
  const closeViewer = el('button', { className: 'viewer-close', type: 'button', ariaLabel: 'Close' }, '✕');
  closeViewer.addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', (event) => { if (event.target === viewer) viewer.close(); }); // backdrop
  viewer.append(el('div', { className: 'viewer-head' }, el('div', {}, viewerTitle, viewerMeta), closeViewer), viewerScroll);

  let labelTimer;
  function updateRail() {
    const { scrollTop, scrollHeight, clientHeight } = viewerBody;
    const scrollable = scrollHeight - clientHeight;
    rail.hidden = scrollable <= 4;
    if (rail.hidden) { railLabel.hidden = true; return; }
    const track = rail.clientHeight;
    const thumb = Math.max(44, Math.round(track * clientHeight / scrollHeight));
    const top = Math.round((track - thumb) * (scrollTop / scrollable));
    railThumb.style.height = `${thumb}px`;
    railThumb.style.transform = `translateY(${top}px)`;
    // The section under the top of the view names the location.
    const viewTop = viewerBody.getBoundingClientRect().top + 12;
    const sections = [...viewerBody.querySelectorAll('.viewer-section')];
    const current = sections.filter((section) => section.getBoundingClientRect().top <= viewTop).pop() || sections[0];
    const name = current ? current.querySelector('summary b')?.textContent : '';
    const percent = Math.round(100 * scrollTop / scrollable);
    railLabel.textContent = name ? `${name} · ${percent}%` : `${percent}%`;
    railLabel.style.top = `${rail.offsetTop + top + thumb / 2}px`;
    railLabel.hidden = false;
    railLabel.classList.add('visible');
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => { if (!dragging) railLabel.classList.remove('visible'); }, 1400);
  }
  viewerBody.addEventListener('scroll', updateRail, { passive: true });
  new ResizeObserver(updateRail).observe(viewerBody);
  new MutationObserver(() => requestAnimationFrame(updateRail)).observe(viewerBody, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });

  // Drag the thumb, or press anywhere on the rail to jump there (thumb centered on the finger).
  let dragging = false;
  let grabOffset = 0;
  function scrollToPointer(clientY) {
    const rect = rail.getBoundingClientRect();
    const thumb = railThumb.offsetHeight;
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top - grabOffset) / Math.max(1, rect.height - thumb)));
    viewerBody.scrollTop = ratio * (viewerBody.scrollHeight - viewerBody.clientHeight);
  }
  rail.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dragging = true;
    rail.setPointerCapture(event.pointerId);
    const thumbRect = railThumb.getBoundingClientRect();
    grabOffset = event.target === railThumb ? event.clientY - thumbRect.top : railThumb.offsetHeight / 2;
    rail.classList.add('dragging');
    scrollToPointer(event.clientY);
  });
  rail.addEventListener('pointermove', (event) => { if (dragging) scrollToPointer(event.clientY); });
  const endDrag = () => { dragging = false; rail.classList.remove('dragging'); updateRail(); };
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);

  // Text with the given [start, end) ranges wrapped in <mark data-hit="i">.
  function highlightedText(text, ranges = []) {
    const nodes = [];
    let at = 0;
    ranges.forEach(([start, end], index) => {
      if (start < at) return;
      const mark = el('mark', { className: 'search-hit' }, text.slice(start, end));
      mark.dataset.hit = String(index);
      nodes.push(text.slice(at, start), mark);
      at = end;
    });
    nodes.push(text.slice(at));
    return nodes;
  }

  function textBlock(label, entry, open = true, key = '', ranges = []) {
    const copy = el('button', { type: 'button' }, 'Copy');
    copy.addEventListener('click', async (event) => {
      event.preventDefault();
      try { await navigator.clipboard.writeText(entry.text); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    const actions = el('span', { className: 'viewer-actions' }, copy);
    if (entry.url) {
      actions.append(el('a', { className: 'bookmark', href: entry.url, target: '_blank', rel: 'noopener noreferrer' },
        `Open in ${entry.provider || 'the AI site'}`));
    }
    const heading = el('summary', {}, el('b', {}, label), entry.provider ? el('span', { className: 'muted' }, ` · ${entry.provider}`) : '', actions);
    const section = el('details', { className: 'viewer-section', open }, heading,
      el('div', { className: 'viewer-text', dir: 'auto' }, ...highlightedText(entry.text, ranges)));
    section.dataset.key = key;
    return section;
  }

  // focus (from search): { ranges: { sectionKey: [[s, e]...] }, key, hit } scrolls to one match.
  async function openViewer(jobId, focus = null) {
    viewerTitle.textContent = 'Loading…';
    viewerMeta.textContent = '';
    viewerBody.replaceChildren();
    if (!viewer.open) viewer.showModal();
    try {
      const d = await post('/api/details', { jobId });
      viewerTitle.textContent = d.title || d.videoId;
      viewerMeta.replaceChildren(
        el('a', { href: `https://www.youtube.com/watch?v=${encodeURIComponent(d.videoId)}`, target: '_blank', rel: 'noopener noreferrer' }, d.videoId),
        ` · ${d.level} · ${d.state} · `,
        d.source
          ? el('a', { href: d.source.url, target: '_blank', rel: 'noopener noreferrer', dir: 'auto' }, `From ${d.source.kind}: ${d.source.title}`)
          : 'Single video');
      const blocks = [];
      const hits = (key) => (focus && focus.ranges && focus.ranges[key]) || [];
      if (d.final) blocks.push(textBlock('Final summary', d.final, true, 'final', hits('final')));
      d.parts.forEach((part) => {
        const key = `part-${part.index}`;
        blocks.push(textBlock(`Part ${part.index} of ${Math.max(d.parts.length, part.index)}`, part, !d.final || hits(key).length > 0, key, hits(key)));
      });
      if (!blocks.length) blocks.push(el('p', { className: 'muted' }, `No summary yet. ${d.message || ''}`));
      else if (!d.final) blocks.unshift(el('p', { className: 'muted' }, `Still working: ${d.message || ''} Parts finished so far are below.`));
      viewerBody.replaceChildren(...blocks);
      viewerBody.scrollTop = 0;
      if (focus && focus.key) {
        const section = viewerBody.querySelector(`.viewer-section[data-key="${focus.key}"]`);
        const mark = section && section.querySelector(`mark[data-hit="${focus.hit || 0}"]`);
        if (section) section.open = true;
        if (mark) {
          mark.classList.add('current');
          requestAnimationFrame(() => mark.scrollIntoView({ block: 'center' }));
        }
      }
      requestAnimationFrame(updateRail);
    } catch (error) {
      viewerTitle.textContent = 'Could not load this summary';
      viewerBody.replaceChildren(el('p', { className: 'muted' }, error.message));
    }
  }

  // ---- Search in all summaries (🔍 in the top bar) ----
  const SCOPE_KEY = 'yt-summary-search-scope';
  let searchVideos = [];
  let scope = null; // null = all videos; otherwise a Set of job ids
  try {
    const saved = JSON.parse(localStorage.getItem(SCOPE_KEY) || 'null');
    if (saved && Array.isArray(saved.ids)) scope = new Set(saved.ids);
  } catch { /* default: all */ }
  const saveScope = () => {
    try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope ? { ids: [...scope] } : { all: true })); } catch { /* private mode */ }
  };

  const searchDialog = el('dialog', { id: 'search-dialog' });
  const savedSlot = el('div', {}); // the saved-searches list is created further down and placed here
  const searchQuery = el('input', { type: 'search', dir: 'auto', placeholder: 'Word or phrase, Hebrew or English', enterKeyHint: 'search', autocomplete: 'off' });
  const contextSelect = el('select', { title: 'Words shown before and after each match' },
    ...[10, 20, 30, 50, 100].map((n) => el('option', { value: String(n), selected: n === 30 }, `${n} words around`)));
  const searchGo = el('button', { type: 'button', className: 'primary' }, 'Search');
  // "Not" phrases: a match that is part of one of these is left out (home, not "home alone").
  const excludes = [];
  const notInput = el('input', { type: 'search', dir: 'auto', placeholder: 'Not… (e.g. home alone)', enterKeyHint: 'done', autocomplete: 'off' });
  const notAdd = el('button', { type: 'button' }, '+ Not');
  const notChips = el('span', { className: 'not-chips' });
  function renderNots() {
    notChips.replaceChildren(...excludes.map((phrase, i) => {
      const remove = el('button', { type: 'button', className: 'not-remove', ariaLabel: `Remove ${phrase}` }, '✕');
      remove.addEventListener('click', () => { excludes.splice(i, 1); renderNots(); if (searchQuery.value.trim().length >= 2) runSearch(); });
      return el('span', { className: 'not-chip', dir: 'auto' }, `not "${phrase}"`, remove);
    }));
  }
  function addNot() {
    const phrase = notInput.value.trim();
    if (!phrase || excludes.includes(phrase)) { notInput.value = ''; return; }
    excludes.push(phrase);
    notInput.value = '';
    renderNots();
    if (searchQuery.value.trim().length >= 2) runSearch();
  }
  notAdd.addEventListener('click', addNot);
  notInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') addNot(); });
  const scopeSummary = el('span', { className: 'scope-summary' });
  const scopeToggle = el('button', { type: 'button' }, 'Choose videos');
  const scopeList = el('div', { className: 'scope-list' });
  const scopeFilter = el('input', { type: 'search', dir: 'auto', placeholder: 'Filter this list by title or channel' });
  const scopeSource = el('select', {});
  const quick = (label, pick) => {
    const b = el('button', { type: 'button' }, label);
    b.addEventListener('click', () => { pick(); renderScope(); });
    return b;
  };
  const dayAgo = (days) => Date.now() - days * 86400000;
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const scopePicker = el('div', { className: 'scope-picker', hidden: true },
    el('div', { className: 'row scope-quick' },
      quick('All', () => { scope = null; }),
      quick('None', () => { scope = new Set(); }),
      quick('Today', () => { scope = new Set(searchVideos.filter((v) => Date.parse(v.createdAt) >= startOfToday()).map((v) => v.id)); }),
      quick('Last 7 days', () => { scope = new Set(searchVideos.filter((v) => Date.parse(v.createdAt) >= dayAgo(7)).map((v) => v.id)); }),
      scopeSource),
    scopeFilter, scopeList);
  const searchResults = el('div', { className: 'search-results' });
  const closeSearch = el('button', { className: 'viewer-close', type: 'button', ariaLabel: 'Close' }, '✕');
  closeSearch.addEventListener('click', () => searchDialog.close());
  searchDialog.addEventListener('click', (event) => { if (event.target === searchDialog) searchDialog.close(); });
  searchDialog.append(
    el('div', { className: 'viewer-head' }, el('div', {}, el('h2', {}, 'Search in summaries'),
      el('p', { className: 'muted' }, 'Finds the words in every summary and part, ignoring Hebrew vowel marks.')), closeSearch),
    el('div', { className: 'search-body' },
      savedSlot,
      el('div', { className: 'row search-form' }, searchQuery, contextSelect, searchGo),
      el('div', { className: 'row search-not' }, notInput, notAdd, notChips),
      el('div', { className: 'row search-scope' }, scopeSummary, scopeToggle),
      scopePicker, searchResults));

  const inScope = (id) => !scope || scope.has(id);
  function renderScope() {
    const chosen = searchVideos.filter((v) => inScope(v.id)).length;
    scopeSummary.textContent = !scope ? `Searching all ${plural(searchVideos.length, 'video')}` : `Searching ${chosen} of ${plural(searchVideos.length, 'video')}`;
    const words = scopeFilter.value.trim().toLowerCase();
    const shown = searchVideos.filter((v) => !words || `${v.title} ${v.videoId} ${v.sourceTitle}`.toLowerCase().includes(words));
    scopeList.replaceChildren(...shown.map((v) => {
      const box = el('input', { type: 'checkbox', checked: inScope(v.id) });
      box.addEventListener('change', () => {
        if (!scope) scope = new Set(searchVideos.map((x) => x.id));
        if (box.checked) scope.add(v.id); else scope.delete(v.id);
        if (scope.size === searchVideos.length) scope = null;
        saveScope();
        renderScope();
      });
      const when = v.createdAt ? new Date(v.createdAt).toLocaleDateString() : '';
      return el('label', { className: 'scope-item' }, box,
        el('span', { dir: 'auto', className: 'scope-title' }, v.title || v.videoId),
        el('span', { className: 'muted' }, `${when} · \u2068${v.sourceTitle || 'Single video'}\u2069`));
    }));
    saveScope();
  }
  scopeFilter.addEventListener('input', renderScope);
  scopeToggle.addEventListener('click', () => {
    scopePicker.hidden = !scopePicker.hidden;
    scopeToggle.textContent = scopePicker.hidden ? 'Choose videos' : 'Done choosing';
  });
  scopeSource.addEventListener('change', () => {
    const value = scopeSource.value;
    if (value === '__all') scope = null;
    else scope = new Set(searchVideos.filter((v) => (value === '__single' ? !v.sourceTitle : v.sourceTitle === value)).map((v) => v.id));
    scopeSource.value = '';
    renderScope();
  });

  async function loadSearchVideos() {
    const { videos } = await api('/api/search/videos');
    searchVideos = videos;
    if (scope) scope = new Set([...scope].filter((id) => videos.some((v) => v.id === id)));
    const sourceNames = [...new Set(videos.map((v) => v.sourceTitle).filter(Boolean))];
    scopeSource.replaceChildren(
      el('option', { value: '' }, 'Only a channel / playlist…'),
      el('option', { value: '__all' }, 'All sources'),
      ...sourceNames.map((name) => el('option', { value: name }, name)),
      el('option', { value: '__single' }, 'Single videos'));
    renderScope();
  }

  function passageBlock(video, section, passage) {
    const ranges = Object.fromEntries(video.sections.map((sec) => [sec.key, sec.ranges]));
    const body = el('div', { className: 'hit-text', dir: 'auto' });
    let at = 0;
    const parts = [];
    passage.highlights.forEach(([start, end], i) => {
      const hit = passage.rangeIndexes[i];
      const mark = el('mark', { className: 'search-hit' }, passage.text.slice(start, end));
      mark.addEventListener('click', (event) => { event.stopPropagation(); openViewer(video.id, { ranges, key: section.key, hit }); });
      parts.push(passage.text.slice(at, start), mark);
      at = end;
    });
    parts.push(passage.text.slice(at));
    body.append(passage.clippedBefore ? '… ' : '', ...parts, passage.clippedAfter ? ' …' : '');
    const block = el('div', { className: 'hit' },
      el('span', { className: 'hit-where' }, `${section.label}${section.provider ? ` · ${section.provider}` : ''}` +
        (passage.rangeIndexes.length > 1 ? ` · ${passage.rangeIndexes.length} matches` : '')), body);
    block.addEventListener('click', () => openViewer(video.id, { ranges, key: section.key, hit: passage.rangeIndexes[0] }));
    return block;
  }

  // ---- Saved searches: filters + the results as they were saved ----
  let currentSaved = null; // { id, name } of the saved search the form was loaded from
  const savedList = el('div', { className: 'saved-list' });
  const savedCount = el('span', { className: 'muted' });
  const savedBlock = el('details', { className: 'saved-searches', hidden: true },
    el('summary', {}, el('b', {}, 'Saved searches '), savedCount), savedList);
  savedSlot.append(savedBlock);

  const filterText = (entry) => [`"${entry.query}"`, ...(entry.exclude || []).map((x) => `not "${x}"`)].join(', ') +
    (entry.jobIds ? ` · in ${plural(entry.jobIds.length, 'chosen video')}` : ' · all videos');

  function setFilters(entry) {
    searchQuery.value = entry.query;
    excludes.splice(0, excludes.length, ...(entry.exclude || []));
    renderNots();
    contextSelect.value = String(entry.contextWords ?? 30);
    scope = entry.jobIds ? new Set(entry.jobIds) : null;
    renderScope();
  }

  async function loadSaved() {
    try {
      const { searches } = await api('/api/searches');
      savedBlock.hidden = searches.length === 0;
      savedCount.textContent = `(${searches.length})`;
      savedList.replaceChildren(...searches.map((entry) => {
        const open = el('button', { type: 'button' }, 'Open');
        open.addEventListener('click', async () => {
          try {
            const full = await post('/api/searches/get', { id: entry.id });
            setFilters(full);
            currentSaved = { id: full.id, name: full.name };
            renderResults(full.results, { savedAt: full.savedAt, name: full.name });
          } catch (error) { searchResults.replaceChildren(el('p', { className: 'muted' }, error.message)); }
        });
        const again = el('button', { type: 'button', className: 'primary' }, 'Run again');
        again.addEventListener('click', () => { setFilters(entry); currentSaved = { id: entry.id, name: entry.name }; runSearch(); });
        const remove = el('button', { type: 'button' }, 'Delete');
        remove.addEventListener('click', async () => {
          if (!confirm(`Delete the saved search "${entry.name}"?`)) return;
          try {
            await post('/api/searches/delete', { id: entry.id });
            if (currentSaved && currentSaved.id === entry.id) currentSaved = null;
            loadSaved();
          } catch (error) { searchResults.replaceChildren(el('p', { className: 'muted' }, error.message)); }
        });
        return el('div', { className: 'saved-row' },
          el('div', { className: 'saved-name', dir: 'auto' }, entry.name),
          el('p', { className: 'muted', dir: 'auto' }, filterText(entry)),
          el('p', { className: 'muted' }, `${plural(entry.matches, 'match', 'matches')} in ${plural(entry.videos, 'video')} · saved ${new Date(entry.savedAt).toLocaleString()}`),
          el('div', { className: 'row source-actions' }, open, again, remove));
      }));
    } catch { /* offline */ }
  }

  async function saveCurrent({ update = false } = {}) {
    const query = searchQuery.value.trim();
    const suggested = update && currentSaved ? currentSaved.name
      : [query, ...excludes.map((x) => `not "${x}"`)].join(', ');
    const name = update ? suggested : prompt('Name for this saved search:', suggested);
    if (name === null) return;
    try {
      const saved = await post('/api/searches/save', {
        name, query, exclude: excludes, contextWords: Number(contextSelect.value),
        ...(scope ? { jobIds: [...scope] } : {}), ...(update && currentSaved ? { id: currentSaved.id } : {}),
      });
      currentSaved = { id: saved.id, name: saved.name };
      savedNote.textContent = update ? `Updated "${saved.name}".` : `Saved as "${saved.name}".`;
      loadSaved();
      savedBlock.open = true;
    } catch (error) {
      savedNote.textContent = `Could not save: ${error.message}`;
    }
  }
  const savedNote = el('span', { className: 'muted', role: 'status' });

  // Shows a result set; `saved` = { savedAt, name } when it is a stored snapshot.
  function renderResults(r, saved = null) {
    const nots = (r.exclude || []).length ? `, not ${r.exclude.map((x) => `"${x}"`).join(', ')}` : '';
    const header = [];
    if (saved) {
      header.push(el('p', { className: 'saved-banner', dir: 'auto' },
        `Saved search "${saved.name}", results as of ${new Date(saved.savedAt).toLocaleString()}. Use Run again for current results.`));
    } else {
      const actions = el('div', { className: 'row source-actions' });
      const save = el('button', { type: 'button' }, '💾 Save this search');
      save.addEventListener('click', () => saveCurrent());
      actions.append(save);
      if (currentSaved) {
        const update = el('button', { type: 'button' }, `Update "${currentSaved.name}"`);
        update.addEventListener('click', () => saveCurrent({ update: true }));
        actions.append(update);
      }
      savedNote.textContent = '';
      actions.append(savedNote);
      header.push(actions);
    }
    if (!r.results.length) {
      searchResults.replaceChildren(...header, el('p', { className: 'muted' }, `No matches for "${r.query}"${nots} in ${plural(r.searched, 'video')}.`));
      return;
    }
    searchResults.replaceChildren(
      ...header,
      el('p', { className: 'search-count' }, `${plural(r.matches, 'match', 'matches')} for "${r.query}"${nots} in ${plural(r.results.length, 'video')} (searched ${r.searched})`),
      ...r.results.map((video) => {
        const title = el('button', { type: 'button', className: 'hit-video-title', dir: 'auto' }, video.title || video.videoId);
        const first = video.sections[0];
        title.addEventListener('click', () => openViewer(video.id, {
          ranges: Object.fromEntries(video.sections.map((sec) => [sec.key, sec.ranges])), key: first.key, hit: 0,
        }));
        const when = video.createdAt ? new Date(video.createdAt).toLocaleDateString() : '';
        return el('section', { className: 'hit-video' }, title,
          el('p', { className: 'muted' }, `${plural(video.matchCount, 'match', 'matches')} · ${when} · \u2068${video.sourceTitle || 'Single video'}\u2069`),
          ...video.sections.flatMap((section) => section.passages.map((passage) => passageBlock(video, section, passage))));
      }));
  }

  async function runSearch() {
    const query = searchQuery.value.trim();
    if (query.length < 2) { searchResults.replaceChildren(el('p', { className: 'muted' }, 'Type at least 2 letters.')); return; }
    if (scope && scope.size === 0) { searchResults.replaceChildren(el('p', { className: 'muted' }, 'No videos are chosen. Use "Choose videos" or All.')); return; }
    searchGo.disabled = true;
    searchResults.replaceChildren(el('p', { className: 'muted' }, 'Searching…'));
    try {
      const r = await post('/api/search', {
        query, exclude: excludes, contextWords: Number(contextSelect.value), ...(scope ? { jobIds: [...scope] } : {}),
      });
      renderResults(r);
    } catch (error) {
      searchResults.replaceChildren(el('p', { className: 'muted' }, `Search failed: ${error.message}`));
    } finally {
      searchGo.disabled = false;
    }
  }
  searchGo.addEventListener('click', runSearch);
  searchQuery.addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(); });
  searchQuery.addEventListener('input', () => { currentSaved = null; });
  contextSelect.addEventListener('change', () => { if (searchQuery.value.trim().length >= 2) runSearch(); });

  const searchButton = el('button', { id: 'topbar-search', type: 'button', title: 'Search in all summaries' }, '🔍 Search');
  searchButton.addEventListener('click', async () => {
    if (!searchDialog.open) searchDialog.showModal();
    searchQuery.focus();
    try { await loadSearchVideos(); } catch (error) { scopeSummary.textContent = error.message; }
    loadSaved();
  });

  // Tapping anywhere on a tile except its own buttons/links/menus opens the viewer.
  document.addEventListener('click', (event) => {
    const card = event.target.closest('.job-card[data-job-id]');
    if (!card || event.target.closest('button, a, select, input, label, summary, textarea')) return;
    openViewer(card.dataset.jobId);
  });

  // ---- Add a playlist or channel: each video becomes its own job. ----
  const LEVEL_NAMES = { ultra: 'Ultra', max: 'Max', reg: 'Reg', min: 'Min', micro: 'Micro', full: 'Full' };
  const importUrl = el('input', {
    id: 'import-url', type: 'url', inputMode: 'url', autocomplete: 'off', spellcheck: false,
    placeholder: 'https://www.youtube.com/playlist?list=…  or  https://www.youtube.com/@channel',
  });
  // Type any number (1 or more), or pick a preset from the list.
  const importLimit = el('input', {
    id: 'import-limit', type: 'number', min: 1, step: 1, value: '1', inputMode: 'numeric',
  });
  importLimit.setAttribute('list', 'import-limit-presets');
  const importPresets = el('datalist', { id: 'import-limit-presets' },
    ...[1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((n) => el('option', { value: String(n) })));
  const importLevel = el('select', { id: 'import-level' },
    ...Object.entries(LEVEL_NAMES).map(([value, label]) => el('option', { value }, label)));
  const importButton = el('button', { className: 'primary', type: 'button' }, 'Add all videos');
  const importResult = el('p', { className: 'muted', role: 'status' });
  const importBlock = el('div', { id: 'import-block' },
    el('div', { className: 'panel-title' }, 'Add a playlist or channel'),
    el('label', { className: 'field', htmlFor: 'import-url' }, 'Playlist link (all its videos) or channel link (its latest videos)'),
    importUrl,
    el('div', { className: 'import-options' },
      el('label', { className: 'field' }, 'Latest videos from a channel', importLimit, importPresets),
      el('label', { className: 'field' }, 'Summary level', importLevel)),
    el('div', { className: 'row' }, importButton),
    importResult,
    el('p', { className: 'muted' }, 'Each video gets its own summary. Videos already summarized at the same level are skipped.'));

  // Saved channels & playlists: every import is remembered so it can be checked again.
  const sourcesList = el('div', { className: 'sources-list' });
  const checkAll = el('button', { type: 'button', hidden: true }, 'Check all for new videos');
  const refreshCounts = el('button', { type: 'button' }, 'Refresh counts');
  const newTotal = el('span', { className: 'new-total', hidden: true });
  const sourcesBlock = el('div', { id: 'sources-block', hidden: true },
    el('div', { className: 'sources-head' },
      el('div', { className: 'panel-title' }, 'Saved channels & playlists ', newTotal),
      el('span', { className: 'row source-actions' }, refreshCounts, checkAll)),
    el('p', { className: 'muted' }, 'New videos are counted automatically every 30 minutes (nothing is added until you press a button).'),
    sourcesList);
  refreshCounts.addEventListener('click', async () => {
    refreshCounts.disabled = true;
    refreshCounts.textContent = 'Counting…';
    try { await post('/api/sources/peek', {}); await loadSources(); }
    catch (error) { importResult.textContent = `Could not refresh counts: ${error.message}`; }
    finally { refreshCounts.disabled = false; refreshCounts.textContent = 'Refresh counts'; }
  });
  importBlock.append(sourcesBlock);

  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
  function describeResult(r, level) {
    const what = r.kind === 'channel' ? 'channel' : 'playlist';
    const parts = [`Found ${plural(r.found, 'video')} in the ${what}${r.title ? ` "${r.title}"` : ''}: ${r.added} added`];
    if (r.alreadyDone) parts.push(`${r.alreadyDone} already summarized at ${LEVEL_NAMES[level] || level} (skipped)`);
    if (r.alreadyListed) parts.push(`${r.alreadyListed} already in the list`);
    if (r.notAdded) parts.push(`${r.notAdded} not added: ${r.error}`);
    return parts.join(', ') + '.';
  }

  function sourceRow(source) {
    const status = el('p', { className: 'muted' });
    const pending = source.pending;
    const newCount = (pending && pending.count) || 0;
    const counter = el('p', { className: newCount ? 'new-count has-new' : 'new-count' });
    if (!pending) counter.textContent = 'New videos: not counted yet';
    else {
      const at = new Date(pending.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      counter.textContent = pending.error ? `Could not count new videos (${at}): ${pending.error}`
        : newCount ? `🆕 ${plural(newCount, 'new video')} not summarized yet (checked ${at})`
          : `No new videos since the last import (checked ${at})`;
    }
    const last = source.lastResult || {};
    const when = source.lastRunAt ? new Date(source.lastRunAt).toLocaleString() : 'never';
    status.textContent = `Last checked ${when}: ${last.added || 0} new` +
      (last.alreadyDone ? `, ${last.alreadyDone} already summarized` : '') + (last.error ? ` (${last.error})` : '');
    const run = el('button', { type: 'button', className: 'primary' }, newCount ? `Add ${plural(newCount, 'new video')}` : 'Check for new videos');
    run.addEventListener('click', async () => {
      run.disabled = true;
      status.textContent = 'Checking YouTube for new videos…';
      try {
        const r = await post('/api/sources/run', { id: source.id });
        status.textContent = describeResult(r, source.summaryLevel);
        setTimeout(loadSources, 4000);
      } catch (error) {
        status.textContent = `Could not check: ${error.message}`;
      } finally { run.disabled = false; }
    });
    const edit = el('button', { type: 'button' }, 'Edit');
    edit.addEventListener('click', () => {
      importUrl.value = source.url;
      importLimit.value = String(source.limit || 1);
      if (LEVEL_NAMES[source.summaryLevel]) importLevel.value = source.summaryLevel;
      importResult.textContent = 'Change the count or level, then press Add all videos to save and check it.';
      importUrl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const remove = el('button', { type: 'button' }, 'Remove');
    remove.addEventListener('click', async () => {
      if (!confirm(`Stop remembering "${source.title}"? Its videos and summaries stay.`)) return;
      try { await post('/api/sources/delete', { id: source.id }); loadSources(); }
      catch (error) { status.textContent = error.message; }
    });
    const settings = source.kind === 'channel' ? `Channel · latest ${source.limit || 1}` : 'Playlist · all videos';
    return el('div', { className: 'source-row' },
      el('a', { className: 'source-title', href: source.url, target: '_blank', rel: 'noopener noreferrer', dir: 'auto' },
        // Entries saved before names were cleaned may still end in yt-dlp's " - Videos".
        (source.title || source.url).replace(/\s+-\s+(Videos|Streams|Shorts|Live)$/i, '')),
      el('p', { className: 'muted' }, `${settings} · ${LEVEL_NAMES[source.summaryLevel] || source.summaryLevel}`),
      counter,
      status,
      el('div', { className: 'row source-actions' }, run, edit, remove));
  }

  async function loadSources() {
    try {
      const { sources } = await api('/api/sources');
      sourcesBlock.hidden = sources.length === 0;
      checkAll.hidden = sources.length < 2;
      const total = sources.reduce((sum, src) => sum + ((src.pending && src.pending.count) || 0), 0);
      newTotal.hidden = total === 0;
      newTotal.textContent = `${total} new`;
      sourcesList.replaceChildren(...[...sources].reverse().map(sourceRow));
    } catch { /* offline */ }
  }

  checkAll.addEventListener('click', async () => {
    checkAll.disabled = true;
    const label = checkAll.textContent;
    checkAll.textContent = 'Checking all…';
    try {
      const { results } = await post('/api/sources/run-all', {});
      const added = results.reduce((sum, r) => sum + (r.added || 0), 0);
      importResult.textContent = `Checked ${plural(results.length, 'saved list')}: ${plural(added, 'new video')} added.`;
      loadSources();
    } catch (error) {
      importResult.textContent = `Could not check all: ${error.message}`;
    } finally {
      checkAll.disabled = false;
      checkAll.textContent = label;
    }
  });
  importButton.addEventListener('click', async () => {
    const url = importUrl.value.trim();
    if (!url) { importResult.textContent = 'Paste a playlist or channel link first.'; return; }
    const limit = Number(importLimit.value);
    if (!Number.isInteger(limit) || limit < 1) {
      importResult.textContent = 'Latest videos must be a whole number, 1 or more.';
      importLimit.focus();
      return;
    }
    importButton.disabled = true;
    importResult.textContent = 'Reading the list from YouTube…';
    try {
      const response = await fetch('/api/import', {
        method: 'POST', headers: { 'X-YT-Token': token(), 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ url, limit, summaryLevel: importLevel.value }),
        signal: AbortSignal.timeout(120000),
      });
      const r = await response.json();
      if (!response.ok) throw new Error(r.error || `Request failed (${response.status}).`);
      importResult.textContent = describeResult(r, importLevel.value) + ' Saved under "Saved channels & playlists".';
      importUrl.value = '';
      loadSources();
    } catch (error) {
      importResult.textContent = `Could not add: ${error.message}`;
    } finally {
      importButton.disabled = false;
    }
  });
  importUrl.addEventListener('keydown', (event) => { if (event.key === 'Enter') importButton.click(); });

  mount();
  document.body.append(viewer, searchDialog);
  const topState = document.querySelector('.topbar #state');
  if (topState) topIp.before(searchButton);
  const addPanel = document.querySelector('section.panel:has(#batch)');
  if (addPanel) addPanel.append(importBlock);
  loadSources();
  setInterval(loadSources, 60000); // pick up the server's background counts
  api('/api/status').then((status) => { if (LEVEL_NAMES[status.summaryLevel]) importLevel.value = status.summaryLevel; }).catch(() => {});
  api('/config').then((config) => {
    signInBlock.hidden = !config.signIn;
    ipBlock.hidden = !config.ipRotation;
    topIp.hidden = !config.ipRotation;
    panel.hidden = !config.signIn && !config.ipRotation;
    if (config.signIn) { refreshLogin(); setInterval(refreshLogin, 15000); }
    if (config.ipRotation) refreshIp();
  }).catch(() => { panel.hidden = true; });
})();
