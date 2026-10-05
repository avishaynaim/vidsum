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
  // How many videos run at the same time (one AI step per site at a time, so up to 3).
  const parallel = el('select', { id: 'max-concurrent' },
    ...[1, 2, 3].map((n) => el('option', { value: String(n) }, n === 1 ? '1 (one at a time)' : `${n} at the same time`)));
  parallel.addEventListener('change', async () => {
    parallel.disabled = true;
    try { await post('/api/settings', { maxConcurrent: Number(parallel.value) }); }
    catch (error) { alert(`Could not save: ${error.message}`); }
    finally { parallel.disabled = false; }
  });
  // Local Whisper: last resort for videos with no captions at all (whisper.js).
  const whisperBox = el('input', { type: 'checkbox', id: 'whisper-fallback' });
  const whisperNote = el('p', { className: 'muted' });
  whisperBox.addEventListener('change', async () => {
    whisperBox.disabled = true;
    try { await post('/api/settings', { whisperFallback: whisperBox.checked }); }
    catch (error) { alert(`Could not save: ${error.message}`); whisperBox.checked = !whisperBox.checked; }
    finally { whisperBox.disabled = false; }
  });
  const whisperBlock = el('div', {},
    el('div', { className: 'panel-title', style: 'margin-top:12px' }, 'Videos with no captions'),
    el('label', { className: 'row', style: 'gap:8px;align-items:center' }, whisperBox, 'Speech-to-text fallback (Whisper)'),
    whisperNote);
  const parallelBlock = el('div', {},
    el('div', { className: 'panel-title', style: 'margin-top:12px' }, 'Videos at the same time'), parallel,
    el('p', { className: 'muted' }, 'Up to 3 videos run together, each on a different AI site (about 3× faster). Extra videos only start while the server has at least 1.5 GB of memory free, and not while the server browser is due for its routine restart (every 20 videos).'));
  // Why the free slots stay empty, refreshed with the queue (status.queueNote, '' when nothing holds them).
  const queueNote = el('div', { className: 'notice', id: 'queue-note', hidden: true });
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
  // Android home-screen widget (../android-widget, server side widget.js): install, ntfy, connect.
  const WIDGET_APK = 'https://github.com/avishaynaim/vidsum/releases/download/widget-latest/yt-summary-widget.apk';
  const widgetConnect = el('a', { className: 'bookmark', style: 'display:inline-block;margin:4px 0', href: '#' }, '3. Connect the Android widget');
  const widgetNote = el('p', { className: 'muted' });
  const widgetBlock = el('div', {},
    el('div', { className: 'panel-title', style: 'margin-top:12px' }, 'Android widget'),
    el('p', { className: 'muted' }, 'Running, queued and unread videos on the phone\'s home screen, updated the moment they change. On the phone:'),
    el('a', { className: 'bookmark', style: 'display:inline-block;margin:4px 6px 4px 0', href: WIDGET_APK }, '1. Install the app'),
    el('a', { className: 'bookmark', style: 'display:inline-block;margin:4px 6px 4px 0', href: 'https://play.google.com/store/apps/details?id=io.heckel.ntfy', target: '_blank', rel: 'noopener' }, '2. Install ntfy (free)'),
    widgetConnect, widgetNote);
  if (location.protocol !== 'https:') {
    widgetConnect.hidden = true;
    widgetNote.textContent = 'To connect, open this dashboard on the phone through its https address (the Tailscale Funnel one, port 8443), so the widget can reach it from anywhere.';
  } else {
    widgetNote.textContent = 'Then long-press the home screen → Widgets → YT Summary.';
    api('/api/widget/setup').then(({ key }) => {
      const q = `server=${encodeURIComponent(location.origin)}&key=${encodeURIComponent(key)}`;
      // Chrome opens the app from an intent: link; without the app it offers the download instead.
      widgetConnect.href = `intent://setup?${q}#Intent;scheme=ytsummary;package=com.vidsum.widget;S.browser_fallback_url=${encodeURIComponent(WIDGET_APK)};end`;
    }).catch(() => { widgetConnect.hidden = true; });
  }
  panel.append(el('div', { className: 'panel-title' }, 'Remote server'), signInBlock, parallelBlock, whisperBlock, widgetBlock, ipBlock);

  function mount() {
    const status = document.querySelector('.col .panel');
    if (status) status.after(panel);
    else document.body.append(panel);
    const state = document.querySelector('.topbar #state');
    if (state) state.before(topIp);
    if (state) state.after(pauseAll);
  }

  // ⏸ Pause all / ▶ Resume in the top bar. Pausing puts running videos back in the queue with
  // their progress saved and holds the queue (both dashboards: they share it); Resume continues.
  const pauseAll = el('button', { id: 'topbar-pause', type: 'button', title: 'Pause or resume all work (Torah and Regular)' }, '⏸ Pause all');
  let queuePaused = false;
  const showPause = (paused) => {
    queuePaused = paused;
    pauseAll.textContent = paused ? '▶ Resume all' : '⏸ Pause all';
    pauseAll.classList.toggle('paused', paused);
  };
  pauseAll.addEventListener('click', async () => {
    if (!queuePaused && !confirm('Pause all work? Running videos stop after saving their progress and go back to the queue. Nothing starts until you press Resume all.')) return;
    pauseAll.disabled = true;
    try {
      await post(queuePaused ? '/api/resume' : '/api/stop', {});
      showPause(!queuePaused);
    } catch (error) {
      alert(`Could not ${queuePaused ? 'resume' : 'pause'}: ${error.message}`);
    } finally {
      pauseAll.disabled = false;
    }
  });
  const syncPause = () => api('/api/status').then((st) => { if (!pauseAll.disabled) showPause(!!st.paused); }).catch(() => {});
  syncPause();
  setInterval(syncPause, 5000);

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
  // Reaching the end of a summary marks it read; this button sets it by hand either way.
  const viewerRead = el('button', { type: 'button', className: 'viewer-read', title: 'Reaching the end marks a summary read; this sets it by hand' });
  const showViewerRead = (isRead) => { viewerRead.dataset.read = isRead ? '1' : ''; viewerRead.textContent = isRead ? '↺ Mark as unread' : '✓ Mark as read'; };
  viewerRead.addEventListener('click', () => {
    const jobId = viewer.dataset.jobId;
    if (!jobId) return;
    const toRead = !viewerRead.dataset.read;
    markRead(jobId, toRead);
    if (readTrack && readTrack.jobId === jobId) { readTrack.read = toRead; if (!toRead) readTrack.saved = 0; }
    if (!toRead) pendingReadNote = false; // no "Marked as read" note when it closes
    showViewerRead(toRead);
  });
  viewer.append(el('div', { className: 'viewer-head' }, el('div', {}, viewerTitle, viewerMeta), viewerRead, closeViewer), viewerScroll);
  // Phones show the title on one line; a tap shows all of it and the details line.
  viewerTitle.addEventListener('click', () => viewer.classList.toggle('head-open'));

  // ---- Auto-scroll (teleprompter) for reading on a phone without scrolling by hand. ----
  // ▶/⏸ scrolls the summary smoothly at an adjustable speed (remembered on this device).
  // A touch pauses it (to reread something); it continues by itself 2 s after the finger
  // lifts. "Next section" jumps to the next part. It stops at the end and when closed.
  const SPEEDS = [8, 12, 16, 21, 27, 34, 42, 52, 64, 80]; // pixels per second
  const SPEED_KEY = 'yt-summary-autoscroll-speed';
  let speedIndex = 3;
  try { const saved = localStorage.getItem(SPEED_KEY); const v = Number(saved); if (saved !== null && saved !== '' && Number.isInteger(v) && v >= 0 && v < SPEEDS.length) speedIndex = v; } catch {}
  let playing = false;
  let heldByTouch = false;
  let heldByEyes = false; // eye-scroll.js: you looked away from the screen
  let resumeTimer = null;
  let frame = null;
  let lastTime = 0;
  let position = 0; // fractional scrollTop (browsers round scrollTop)
  let wakeLock = null;
  // Icon + a text label (.lbl) that phones hide, so the bar stays one thin row there.
  const label = (icon, text) => [icon, el('span', { className: 'lbl' }, ` ${text}`)];
  const playButton = el('button', { type: 'button', className: 'autoscroll-play', title: 'Auto-scroll' }, ...label('▶', 'Auto-scroll'));
  const slower = el('button', { type: 'button', title: 'Slower' }, '−');
  const faster = el('button', { type: 'button', title: 'Faster' }, '+');
  const speedLabel = el('span', { className: 'autoscroll-speed' });
  const nextSection = el('button', { type: 'button', title: 'Jump to the next section' }, ...label('⤓', 'Next section'));
  // How far through the text you are; lives in the bar so it never covers the text (the start of
  // a Hebrew line is on the right, where the rail is).
  const readPercent = el('span', { className: 'autoscroll-percent', title: 'How far through the text you are' }, '0%');
  const autoBar = el('div', { className: 'autoscroll-bar' }, playButton, slower, speedLabel, faster, nextSection, readPercent);
  viewer.append(autoBar);
  const showSpeed = () => { speedLabel.replaceChildren(el('span', { className: 'lbl' }, 'Speed '), String(speedIndex + 1)); };
  showSpeed();
  const atEnd = () => viewerBody.scrollTop >= viewerBody.scrollHeight - viewerBody.clientHeight - 1;

  function step(time) {
    frame = null;
    if (!playing || heldByTouch || heldByEyes) return;
    const dt = lastTime ? Math.min(0.25, (time - lastTime) / 1000) : 0; // a slow phone still keeps the speed
    lastTime = time;
    position += SPEEDS[speedIndex] * dt;
    viewerBody.scrollTop = position;
    if (atEnd()) { setPlaying(false); return; }
    frame = requestAnimationFrame(step);
  }
  function kick() {
    if (frame) cancelAnimationFrame(frame);
    position = viewerBody.scrollTop;
    lastTime = 0;
    frame = requestAnimationFrame(step);
  }
  async function setPlaying(on) {
    playing = on;
    heldByTouch = false;
    clearTimeout(resumeTimer);
    playButton.replaceChildren(...(on ? label('⏸', 'Pause') : label('▶', 'Auto-scroll')));
    playButton.classList.toggle('on', on);
    if (on) {
      if (atEnd()) viewerBody.scrollTop = 0;
      kick();
      // Keep the screen on while it scrolls by itself (browsers allow this on https only).
      try { if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    } else {
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }
  }
  playButton.addEventListener('click', () => setPlaying(!playing));
  const setSpeed = (delta) => {
    speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, speedIndex + delta));
    try { localStorage.setItem(SPEED_KEY, String(speedIndex)); } catch {}
    showSpeed();
  };
  slower.addEventListener('click', () => setSpeed(-1));
  faster.addEventListener('click', () => setSpeed(1));
  nextSection.addEventListener('click', () => {
    const top = viewerBody.getBoundingClientRect().top;
    const next = [...viewerBody.querySelectorAll('.viewer-section')].find((sec) => sec.getBoundingClientRect().top > top + 8);
    viewerBody.scrollTo({ top: next ? viewerBody.scrollTop + next.getBoundingClientRect().top - top : viewerBody.scrollHeight, behavior: 'smooth' });
    if (playing) { heldByTouch = true; clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { heldByTouch = false; kick(); }, 1200); }
  });
  // A finger (or mouse wheel) on the text takes over; auto-scroll continues after it lets go.
  const hold = () => { if (!playing) return; heldByTouch = true; clearTimeout(resumeTimer); };
  const release = () => {
    if (!playing) return;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { heldByTouch = false; kick(); }, 2000);
  };
  viewerBody.addEventListener('touchstart', hold, { passive: true });
  viewerBody.addEventListener('touchend', release, { passive: true });
  viewerBody.addEventListener('touchcancel', release, { passive: true });
  viewerBody.addEventListener('wheel', () => { hold(); release(); }, { passive: true });
  viewer.addEventListener('close', () => setPlaying(false));

  // Keyboard reading: Space / Page Down = a screen down, Shift+Space / Page Up = up, arrows =
  // a few lines, Home / End = start / end. The text gets the focus when a summary opens (else
  // the first button had it, and Space pressed "Mark as unread").
  viewerBody.tabIndex = -1;
  // After clicking a control (▶, speed, read…), keys go back to the text.
  viewer.addEventListener('click', (event) => {
    if (event.target.closest('.autoscroll-bar button, .viewer-read')) setTimeout(() => viewerBody.focus({ preventScroll: true }), 0);
  });
  viewer.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === ' ' && event.target.closest('button, a')) return; // Space on a focused button presses it
    if (viewer.querySelector('.eye-cal, .eye-tune')) return; // calibrating / fine-tuning
    const pageStep = viewerBody.clientHeight * 0.9, lineStep = 64;
    const moves = {
      ' ': event.shiftKey ? -pageStep : pageStep, PageDown: pageStep, PageUp: -pageStep,
      ArrowDown: lineStep, ArrowUp: -lineStep, Home: -Infinity, End: Infinity,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const by = moves[event.key];
    const top = by === Infinity ? viewerBody.scrollHeight : by === -Infinity ? 0 : viewerBody.scrollTop + by;
    if (playing) { viewerBody.scrollTop = top; kick(); } // auto-scroll continues from the new spot
    else viewerBody.scrollTo({ top, behavior: event.repeat ? 'auto' : 'smooth' });
  });

  // ---- 👁 Eye page-turn (beta): eye-scroll.js, loaded only when switched on. ----
  const eyeButton = el('button', { type: 'button', className: 'eye-toggle', title: 'Turn the page with your eyes (beta, https link only)' }, ...label('👁', 'Eyes'));
  autoBar.append(eyeButton);
  let eyeSession = null;
  eyeButton.addEventListener('click', async () => {
    if (eyeSession) { eyeSession.stop(); return; }
    eyeButton.disabled = true;
    try {
      const { start } = await import('/eye-scroll.js');
      eyeSession = await start({
        viewer, body: viewerBody, bar: autoBar, button: eyeButton, label,
        // Auto-scroll waits while you look away, and continues when you look back.
        setLookingAway: (away) => {
          if (heldByEyes === away) return;
          heldByEyes = away;
          if (!away && playing && !heldByTouch) kick();
        },
        onStop: () => { eyeSession = null; heldByEyes = false; if (playing && !heldByTouch) kick(); },
      });
    } catch (error) {
      eyeButton.replaceChildren(...label('👁', 'Eyes'));
      alert(error.message);
    } finally {
      eyeButton.disabled = false;
    }
  });
  viewer.addEventListener('close', () => { if (eyeSession) eyeSession.stop(); });

  // ---- Reading position: a summary counts as read only once its end is reached. ----
  // Where you stopped (0..1 of the scrollable text) is saved on the server while you scroll and
  // when the viewer closes, so reopening it - on any device - continues from there.
  let readTrack = null; // { jobId, read, saved, pos, timer }
  const readPosNow = () => {
    const scrollable = viewerBody.scrollHeight - viewerBody.clientHeight;
    return scrollable > 4 ? Math.min(1, Math.max(0, viewerBody.scrollTop / scrollable)) : 1;
  };
  const atTextEnd = () => viewerBody.scrollTop >= viewerBody.scrollHeight - viewerBody.clientHeight - 24;
  function saveReadPos() {
    const t = readTrack;
    if (!t) return;
    clearTimeout(t.timer);
    // The last position measured while the viewer was open: once it closes the text has no
    // height and would read as "the end".
    const pos = Math.round(t.pos * 1000) / 1000;
    if (Math.abs(pos - t.saved) < 0.01) return;
    t.saved = pos;
    post('/api/read-pos', { jobId: t.jobId, pos }).catch(() => {}); // a lost position is harmless
  }
  function checkReadEnd() {
    const t = readTrack;
    if (!t || t.read || !atTextEnd()) return;
    t.read = true;
    markRead(t.jobId, true);
    showViewerRead(true);
  }
  function startReadTracking(jobId, read, saved) {
    if (viewer.dataset.jobId !== jobId || !viewer.open) return;
    readTrack = { jobId, read, saved, pos: readPosNow(), timer: null };
    checkReadEnd(); // a summary short enough to fit on the screen is read at once
  }
  viewerBody.addEventListener('scroll', () => {
    const t = readTrack;
    if (!t) return;
    t.pos = readPosNow();
    checkReadEnd();
    clearTimeout(t.timer);
    t.timer = setTimeout(() => saveReadPos(), 1200);
  }, { passive: true });
  viewer.addEventListener('close', () => { saveReadPos(); readTrack = null; });

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
    const percent = Math.round(100 * scrollTop / scrollable);
    readPercent.textContent = `${percent}%`;
    // The bubble beside the rail only while a finger drags it (choosing where to jump): any other
    // scrolling - auto-scroll, the eyes, a swipe - kept it up over the start of the lines.
    railLabel.textContent = `${percent}%`;
    railLabel.style.top = `${rail.offsetTop + top + thumb / 2}px`;
    railLabel.hidden = false;
    clearTimeout(labelTimer);
    if (dragging) railLabel.classList.add('visible');
    else labelTimer = setTimeout(() => railLabel.classList.remove('visible'), 700);
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

  // "📜 Full transcript": everything said in the video, loaded when the section is opened
  // (the server may fetch it from YouTube once). "Clean version" makes a Full-level job, where
  // the AI adds punctuation, paragraphs and niqqud.
  function transcriptBlock(jobId, level) {
    const body = el('div', { className: 'viewer-text', dir: 'auto' }, el('p', { className: 'muted' }, 'Loading the transcript…'));
    const copy = el('button', { type: 'button', hidden: true }, 'Copy');
    const clean = el('button', { type: 'button', title: 'A new job at the Full level: the transcript with punctuation, paragraphs and niqqud added by the AI' }, 'Clean version');
    if (level === 'full') clean.hidden = true;
    const heading = el('summary', {}, el('b', {}, '📜 Full transcript'), el('span', { className: 'muted' }, ' · word for word'),
      el('span', { className: 'viewer-actions' }, copy, clean));
    const section = el('details', { className: 'viewer-section viewer-transcript' }, heading, body);
    section.dataset.key = 'transcript';
    let text = null;
    section.addEventListener('toggle', async () => {
      if (!section.open || text !== null) return;
      text = '';
      try {
        const t = await post('/api/transcript', { jobId });
        text = t.text;
        // One long caption string reads badly: paragraphs of a few sentences, or (auto-captions
        // have no punctuation) of about 60 words.
        const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?:])\s+/);
        const paragraphs = [];
        let current = [];
        for (const sentence of sentences) {
          for (const word of sentence.split(' ')) {
            current.push(word);
            if (current.length >= 60) { paragraphs.push(current.join(' ')); current = []; }
          }
          if (current.length >= 35) { paragraphs.push(current.join(' ')); current = []; } // a sentence end is a good break
        }
        if (current.length) paragraphs.push(current.join(' '));
        body.replaceChildren(...paragraphs.map((p) => el('p', {}, p)));
        copy.hidden = false;
      } catch (error) {
        text = null; // try again on the next open
        body.replaceChildren(el('p', { className: 'muted' }, error.message));
      }
    });
    copy.addEventListener('click', async (event) => {
      event.preventDefault();
      try { await navigator.clipboard.writeText(text || ''); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    clean.addEventListener('click', async (event) => {
      event.preventDefault();
      clean.disabled = true;
      try {
        const made = await post('/api/resummarize', { jobId, summaryLevel: 'full' });
        clean.textContent = made.alreadyExisted ? 'Already in the list' : 'Added to the list ✓';
      } catch (error) { clean.textContent = 'Failed'; alert(error.message); }
    });
    return section;
  }

  // focus (from search): { ranges: { sectionKey: [[s, e]...] }, key, hit } scrolls to one match.
  async function openViewer(jobId, focus = null) {
    viewerTitle.textContent = 'Loading…';
    viewerMeta.textContent = '';
    viewerBody.replaceChildren();
    viewer.dataset.jobId = jobId;
    if (!viewer.open) viewer.showModal();
    viewerBody.focus({ preventScroll: true }); // keys scroll the text, not press the first button
    readTrack = null; // nothing is tracked until the text is in place (scrollTop jumps while loading)
    showViewerRead(false);
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
      blocks.push(transcriptBlock(jobId, d.level));
      viewerBody.replaceChildren(...blocks);
      viewerBody.scrollTop = 0;
      showViewerRead(!!d.readAt);
      // An unfinished summary continues where it was left (a finished one starts at the top).
      const resumeAt = !d.readAt && !(focus && focus.key) && d.readPos > 0.01 && d.readPos < 1 ? d.readPos : 0;
      if (resumeAt) {
        requestAnimationFrame(() => {
          viewerBody.scrollTop = resumeAt * Math.max(0, viewerBody.scrollHeight - viewerBody.clientHeight);
          showToast(`Continuing where you stopped (${Math.round(resumeAt * 100)}%)`, false);
        });
      }
      requestAnimationFrame(() => requestAnimationFrame(() => startReadTracking(jobId, !!d.readAt, resumeAt)));
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

  // "Retry all failed (N)": failed videos from any day, next to the dashboard's Clear failed.
  const retryFailed = el('button', { id: 'retry-all-failed', type: 'button', hidden: true });
  let failedCount = 0;
  async function refreshFailed() {
    try {
      const status = await api('/api/status');
      failedCount = status.jobs.filter((j) => j.State === 'error' && !j.WatchLater).length;
      retryFailed.hidden = failedCount === 0;
      if (!retryFailed.disabled) retryFailed.textContent = `Retry all failed (${failedCount})`;
    } catch { /* offline */ }
  }
  retryFailed.addEventListener('click', async () => {
    if (!confirm(`Retry all ${failedCount} failed videos? Each continues from its saved progress, and the queue starts.`)) return;
    retryFailed.disabled = true;
    retryFailed.textContent = 'Retrying…';
    try {
      const r = await post('/api/retry-failed', {});
      retryFailed.textContent = `Queued ${r.retried} for retry`;
    } catch (error) {
      retryFailed.textContent = `Retry failed: ${error.message}`;
    }
    setTimeout(() => { retryFailed.disabled = false; refreshFailed(); }, 4000);
  });

  // ---- Select several finished videos and open each summary in its own tab. ----
  // Browsers allow one new tab per click and block the rest as pop-ups until the site is
  // allowed ("Always allow pop-ups"); blocked tabs are counted and explained.
  const selected = new Set();
  window.ytSelected = selected;
  const selectAll = el('input', { type: 'checkbox', id: 'select-all-shown' });
  const selCount = el('span', { className: 'sel-count' });
  const openTabs = el('button', { type: 'button', className: 'sel-open' }, 'Open in tabs');
  const clearSel = el('button', { type: 'button' }, 'Clear');
  const selNote = el('p', { className: 'muted sel-note', hidden: true });
  const selBar = el('div', { className: 'select-bar' },
    el('label', { title: 'Select every finished video the filters show' }, selectAll, ' Select all'), selCount, openTabs, clearSel);
  // Only tiles you can actually see: some are hidden by CSS but still in the page (Hide read,
  // a collapsed section), and "Select all" counted those too.
  const visible = (node) => (node.checkVisibility ? node.checkVisibility() : node.offsetParent !== null);
  const shownPicks = () => [...document.querySelectorAll('.job-card .tile-pick')].filter((b) => !b.hidden && visible(b.closest('.job-card')));
  function refreshSelection() {
    for (const box of shownPicks()) { const id = box.closest('.job-card').dataset.jobId; box.checked = selected.has(id); }
    const shown = shownPicks();
    const on = shown.filter((b) => b.checked).length;
    selectAll.checked = shown.length > 0 && on === shown.length;
    selectAll.indeterminate = on > 0 && on < shown.length;
    selCount.textContent = selected.size ? `${selected.size} selected` : '';
    openTabs.disabled = clearSel.disabled = selected.size === 0;
    openTabs.textContent = selected.size > 1 ? `Open ${selected.size} in tabs` : 'Open in tabs';
  }
  window.ytSelect = (jobId, on) => { if (on) selected.add(jobId); else selected.delete(jobId); refreshSelection(); };
  selectAll.addEventListener('change', () => {
    for (const box of shownPicks()) { const id = box.closest('.job-card').dataset.jobId; if (selectAll.checked) selected.add(id); else selected.delete(id); }
    refreshSelection();
  });
  clearSel.addEventListener('click', () => { selected.clear(); selNote.hidden = true; refreshSelection(); });
  openTabs.addEventListener('click', () => {
    const ids = [...selected];
    let blocked = 0;
    for (const id of ids) {
      if (window.open(`${location.pathname}#summary=${id}`, '_blank')) selected.delete(id); // opened: leave the selection
      else blocked++;
    }
    selNote.hidden = !blocked;
    if (blocked) {
      selNote.textContent = `The browser blocked ${blocked} of ${ids.length} tabs (it allows one per click). Tap the blocked ` +
        'pop-up icon in the address bar and choose "Always allow pop-ups" for this site, then press the button again. ' +
        'Or keep pressing it: each press opens at least the next one.';
    }
    refreshSelection();
  });
  const filtersBox = document.getElementById('length-filters') || document.getElementById('status-filters');
  if (filtersBox) filtersBox.after(selBar, selNote);
  refreshSelection();
  setInterval(refreshSelection, 2000); // the list re-renders; keep "select all" in step with what is shown

  // Ctrl/⌘+click or middle-click on a tile (or its "Open summary") opens that summary in a new
  // tab, so several can be opened one after another; a plain click still opens it here.
  const summaryUrl = (jobId) => `${location.pathname}#summary=${jobId}`;
  const openInTab = (event) => {
    const card = event.target.closest('.job-card[data-job-id]');
    if (!card) return;
    const control = event.target.closest('button, a, select, input, label, summary, textarea');
    if (control && !/^\s*Open summary/.test(control.textContent)) return; // other buttons/links keep their own meaning
    const newTab = event.type === 'auxclick' ? event.button === 1 : (event.ctrlKey || event.metaKey);
    if (!newTab) return;
    event.preventDefault();
    event.stopImmediatePropagation(); // not also in this tab
    window.open(summaryUrl(card.dataset.jobId), '_blank');
  };
  document.addEventListener('click', openInTab, true);
  document.addEventListener('auxclick', openInTab, true);
  // Opened from such a link: show that summary right away.
  if (window.__openSummary) setTimeout(() => openViewer(window.__openSummary), 0);

  // Tapping anywhere on a tile except its own buttons/links/menus opens the viewer.
  document.addEventListener('click', (event) => {
    const card = event.target.closest('.job-card[data-job-id]');
    if (!card) return;
    const control = event.target.closest('button, a, select, input, label, summary, textarea');
    if (control) return;
    openViewer(card.dataset.jobId);
  });

  // ---- Read marks: a tile whose summary was read to the end is dimmed with "✓ Read" (app.js render,
  // patched in remote-dashboard.js), so the same summary is not opened twice by accident. ----
  // Ctrl+Z / ⌘Z (outside text boxes) cancels the last "read" (from reading a summary or the
  // Mark as read button), back to unread; the note shown when a summary closes has the same
  // Undo for phones. Only reads are undone, not "Mark as unread".
  const readUndo = [];
  const toast = el('div', { className: 'read-toast', hidden: true });
  document.body.append(toast);
  let toastTimer = null;
  function showToast(text, undoable) {
    const undo = el('button', { type: 'button' }, 'Undo');
    undo.addEventListener('click', undoRead);
    toast.replaceChildren(el('span', {}, text), ...(undoable ? [undo] : []));
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }
  function markRead(jobId, read = true, { fromUndo = false } = {}) {
    const card = document.querySelector(`.job-card[data-job-id="${jobId}"]`);
    const was = card ? card.classList.contains('is-read') : !read;
    if (card) card.classList.toggle('is-read', read); // at once; the next poll confirms it
    if (!read) { const i = readUndo.lastIndexOf(jobId); if (i >= 0) readUndo.splice(i, 1); } // already unread: nothing left to undo
    if (!fromUndo && read && !was) {
      readUndo.push(jobId);
      if (readUndo.length > 20) readUndo.shift();
      if (viewer.open) pendingReadNote = true; // shown when the summary closes
      else showToast('Marked as read', true);
    }
    // Not silent: a failed save (e.g. a moment without connection) puts the mark back and says so.
    return post('/api/mark-read', { jobId, read }).catch((error) => {
      if (card) card.classList.toggle('is-read', was);
      if (viewer.open && viewer.dataset.jobId === jobId) showViewerRead(was);
      showToast(`Could not save "${read ? 'read' : 'unread'}": ${error.message}. Try again.`, false);
    });
  }
  let pendingReadNote = false;
  viewer.addEventListener('close', () => { if (pendingReadNote) { pendingReadNote = false; showToast('Marked as read', true); } });
  function undoRead() {
    const jobId = readUndo.pop();
    if (!jobId) { showToast('Nothing to undo', false); return; }
    markRead(jobId, false, { fromUndo: true });
    showToast('Read cancelled: back to unread', false);
  }
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return;
    if (event.target.closest('input, textarea, select, [contenteditable]')) return; // their own undo
    event.preventDefault();
    undoRead();
  });
  window.ytMarkRead = markRead; // the tile's "Mark as read / unread" button (remote-dashboard.js)
  window.ytOpenViewer = openViewer; // the tile's "Open summary" button (remote-dashboard.js)
  // "Hide read" chip next to the status filters; remembered in this browser.
  const HIDE_READ_KEY = 'yt-summary-hide-read';
  let hideReadSaved = false;
  try { hideReadSaved = localStorage.getItem(HIDE_READ_KEY) === '1'; } catch {}
  const hideRead = el('input', { type: 'checkbox', id: 'filter-hide-read', checked: hideReadSaved });
  const applyHideRead = () => {
    document.body.classList.toggle('hide-read', hideRead.checked);
    try { localStorage.setItem(HIDE_READ_KEY, hideRead.checked ? '1' : '0'); } catch {}
  };
  hideRead.addEventListener('change', applyHideRead);
  applyHideRead();
  const statusChips = document.querySelector('#status-filters .chips');
  if (statusChips) statusChips.append(el('label', { className: 'provider-toggle', title: 'Hide videos whose summary you already opened' }, hideRead, ' Hide read'));

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
    const pic = el('img', { className: 'source-pic', loading: 'lazy', alt: '',
      src: `/thumb/list?url=${encodeURIComponent(source.url)}&token=${encodeURIComponent(token())}` });
    pic.classList.toggle('playlist', source.kind !== 'channel');
    pic.onerror = () => { pic.hidden = true; };
    return el('div', { className: 'source-row' },
      pic,
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
  // Each open dialog (summary viewer, search) gets its own history entry (#summary=<id> /
  // #search), so the phone's Back button closes it and returns to the list instead of leaving
  // the dashboard. Closing it any other way (✕, backdrop, Esc) drops that entry again.
  // Closing a dialog also gives focus back to whatever had it before it opened (a tap on a tile
  // focuses nothing, so often something far down the page) and the browser scrolls there:
  // after reading a summary the list jumped to the end. So the page is put back where it was.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  for (const dialog of [viewer, searchDialog]) {
    let saved = null;
    const showModal = dialog.showModal.bind(dialog);
    dialog.showModal = () => {
      saved = { x: window.scrollX, y: window.scrollY };
      showModal();
      const hash = dialog === viewer && dialog.dataset.jobId ? `#summary=${dialog.dataset.jobId}` : '#search';
      history.pushState({ dialog: dialog.id }, '', location.pathname + hash);
    };
    dialog.addEventListener('close', () => {
      if (history.state && history.state.dialog === dialog.id) history.back(); // closed by ✕/Esc
      if (!saved) return;
      const { x, y } = saved;
      saved = null;
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      window.scrollTo(x, y);
      requestAnimationFrame(() => window.scrollTo(x, y)); // after any late focus scroll
      setTimeout(() => window.scrollTo(x, y), 250); // and after Back's own navigation settles
    });
  }
  window.addEventListener('popstate', () => {
    for (const dialog of [viewer, searchDialog]) {
      if (dialog.open && !(history.state && history.state.dialog === dialog.id)) dialog.close(); // Back
    }
  });
  const topState = document.querySelector('.topbar #state');
  if (topState) topIp.before(searchButton);
  const clearFailed = document.querySelector('#clear-errors');
  if (clearFailed) clearFailed.before(retryFailed);
  refreshFailed();
  setInterval(refreshFailed, 10000);
  const message = document.querySelector('#message');
  if (message) message.before(queueNote);
  const refreshQueueNote = () => api('/api/status').then((status) => {
    queueNote.textContent = status.queueNote || '';
    queueNote.hidden = !status.queueNote;
  }).catch(() => {});
  refreshQueueNote();
  setInterval(refreshQueueNote, 10000);
  const addPanel = document.querySelector('section.panel:has(#batch)');
  if (addPanel) addPanel.append(importBlock);
  loadSources();
  setInterval(loadSources, 60000); // pick up the server's background counts
  api('/api/status').then((status) => {
    if (LEVEL_NAMES[status.summaryLevel]) importLevel.value = status.summaryLevel;
    if (status.maxConcurrent) parallel.value = String(status.maxConcurrent);
    whisperBox.checked = status.whisperFallback !== false;
    whisperNote.textContent = status.whisperMissing
      ? `Not set up on the server (missing ${status.whisperMissing}); videos with no captions fail as before.`
      : status.whisperEngine === 'modal'
      ? 'A video with no captions is transcribed through NotebookLM (about 2 minutes). Only if that fails, Whisper ' +
        'transcribes it in the cloud on Modal\'s free tier: all parts at once, usually 3-5 minutes, nothing heavy on this server.'
      : 'A video with no captions is transcribed through NotebookLM (about 2 minutes). Only if that fails, Whisper ' +
        'transcribes it on this server, and this machine is far too slow for it: measured over 30× the video length ' +
        '(a 1-hour video takes a day or more, with 3 of the 4 cores busy). Best left off here.';
  }).catch(() => {});
  api('/config').then((config) => {
    signInBlock.hidden = !config.signIn;
    ipBlock.hidden = !config.ipRotation;
    topIp.hidden = !config.ipRotation;
    panel.hidden = !config.signIn && !config.ipRotation;
    if (config.signIn) { refreshLogin(); setInterval(refreshLogin, 15000); }
    if (config.ipRotation) refreshIp();
  }).catch(() => { panel.hidden = true; });
})();
