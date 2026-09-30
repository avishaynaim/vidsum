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
  const closeViewer = el('button', { className: 'viewer-close', type: 'button', ariaLabel: 'Close' }, '✕');
  closeViewer.addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', (event) => { if (event.target === viewer) viewer.close(); }); // backdrop
  viewer.append(el('div', { className: 'viewer-head' }, el('div', {}, viewerTitle, viewerMeta), closeViewer), viewerBody);

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
        ` · ${d.level} · ${d.state}`);
      const blocks = [];
      if (d.final) blocks.push(textBlock('Final summary', d.final, true));
      d.parts.forEach((part) => blocks.push(textBlock(`Part ${part.index} of ${Math.max(d.parts.length, part.index)}`, part, !d.final)));
      if (!blocks.length) blocks.push(el('p', { className: 'muted' }, `No summary yet. ${d.message || ''}`));
      else if (!d.final) blocks.unshift(el('p', { className: 'muted' }, `Still working: ${d.message || ''} Parts finished so far are below.`));
      viewerBody.replaceChildren(...blocks);
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
  // Type any number from 1 to 50, or pick a preset from the list.
  const importLimit = el('input', {
    id: 'import-limit', type: 'number', min: 1, max: 50, step: 1, value: '1', inputMode: 'numeric',
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
      el('label', { className: 'field' }, 'Latest videos from a channel (1–50)', importLimit, importPresets),
      el('label', { className: 'field' }, 'Summary level', importLevel)),
    el('div', { className: 'row' }, importButton),
    importResult,
    el('p', { className: 'muted' }, 'Each video gets its own summary. Videos already summarized at the same level are skipped.'));

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  importButton.addEventListener('click', async () => {
    const url = importUrl.value.trim();
    if (!url) { importResult.textContent = 'Paste a playlist or channel link first.'; return; }
    const limit = Number(importLimit.value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      importResult.textContent = 'Latest videos must be a whole number from 1 to 50.';
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
      const what = r.kind === 'channel' ? 'channel' : 'playlist';
      const parts = [`Found ${plural(r.found, 'video')} in the ${what}${r.title ? ` "${r.title}"` : ''}: ${r.added} added`];
      if (r.alreadyDone) parts.push(`${r.alreadyDone} already summarized at ${LEVEL_NAMES[importLevel.value]} (skipped)`);
      if (r.alreadyListed) parts.push(`${r.alreadyListed} already in the list`);
      if (r.notAdded) parts.push(`${r.notAdded} not added: ${r.error}`);
      importResult.textContent = parts.join(', ') + '.';
      if (r.added) importUrl.value = '';
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
