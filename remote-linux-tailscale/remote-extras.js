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

  function textBlock(label, entry, open = true) {
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
    return el('details', { className: 'viewer-section', open }, heading, el('div', { className: 'viewer-text', dir: 'auto' }, entry.text));
  }

  async function openViewer(jobId) {
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
      if (d.final) blocks.push(textBlock('Final summary', d.final, true));
      d.parts.forEach((part) => blocks.push(textBlock(`Part ${part.index} of ${Math.max(d.parts.length, part.index)}`, part, !d.final)));
      if (!blocks.length) blocks.push(el('p', { className: 'muted' }, `No summary yet. ${d.message || ''}`));
      else if (!d.final) blocks.unshift(el('p', { className: 'muted' }, `Still working: ${d.message || ''} Parts finished so far are below.`));
      viewerBody.replaceChildren(...blocks);
      viewerBody.scrollTop = 0;
      requestAnimationFrame(updateRail);
    } catch (error) {
      viewerTitle.textContent = 'Could not load this summary';
      viewerBody.replaceChildren(el('p', { className: 'muted' }, error.message));
    }
  }

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

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
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
  document.body.append(viewer);
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
