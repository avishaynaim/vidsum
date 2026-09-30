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
  }

  const LOGIN_TEXT = { 'signed-in': '✅', 'signed-out': '❌ not logged in', 'no-tab': '– not opened', loading: '… loading', unknown: '?' };
  async function refreshLogin() {
    try {
      const { status } = await api('/signin/status');
      const names = Object.keys(status);
      loginList.replaceChildren(...names.map((name) => el('span', { className: 'provider-toggle' }, `${name} ${LOGIN_TEXT[status[name]] || status[name]}`)));
      const ready = names.filter((n) => status[n] === 'signed-in').length;
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
      next = 5000;
    }
    ipTimer = setTimeout(refreshIp, next);
  }
  rotate.addEventListener('click', async () => {
    if (!confirm('Change the public IP now? The server goes offline for about 1–2 minutes.')) return;
    rotate.disabled = true;
    try { await api('/ip/rotate', 'POST'); } catch (error) { ipState.textContent = error.message; }
    refreshIp();
  });

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

  mount();
  document.body.append(viewer);
  api('/config').then((config) => {
    signInBlock.hidden = !config.signIn;
    ipBlock.hidden = !config.ipRotation;
    panel.hidden = !config.signIn && !config.ipRotation;
    if (config.signIn) { refreshLogin(); setInterval(refreshLogin, 15000); }
    if (config.ipRotation) refreshIp();
  }).catch(() => { panel.hidden = true; });
})();
