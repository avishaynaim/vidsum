// remote-linux-tailscale/eye-scroll.js  (ES module, loaded by remote-extras.js on "👁 Eyes")
//
// Eye page-turn for the summary viewer, on a phone's front camera, all on the device.
// Design from the research (DynamicRead 2023, gaze scrolling while reading on phones):
//   - "Eye-Swipe" won: read down to the bottom, flick the eyes back to the top -> next page.
//     A dwell on the bottom works as a fallback. Guessing reading speed frustrated people.
//   - Page by ~90% of a screen and mark the line you were on (Kumar & Winograd's GazeMarker).
// Only a coarse question is asked: is the gaze at the top, middle or bottom of the screen?
// That is what a phone camera can answer reliably; an exact gaze point it cannot.
// Gaze signal: MediaPipe Face Landmarker (iris position between the eyelids, the eye-look
// blendshapes and head pitch), mapped to screen height by a 3-dot calibration.

const MP = '/vendor/mediapipe';
const CAL_KEY = 'yt-summary-eye-calibration';
const TUNE_KEY = 'yt-summary-eye-tuning';
// Your own adjustments from the ⚙ panel (saved on this phone). shift/sensitivity act on the
// gaze estimate; the rest are the page-turn rules.
const TUNE_DEFAULT = { shift: 0, sensitivity: 1, bottomZone: 0.70, dwellMs: 2200, page: 0.88 };
const T = {
  fps: 15,              // detections per second (battery)
  smooth: 0.35,         // EMA weight of a new sample
  topZone: 0.33,        // gaze y (0 top .. 1 bottom) above this = top zone
  bottomZone: 0.70,     // below this = bottom zone
  armMs: 450,           // in the bottom zone this long arms the eye-swipe
  swipeMs: 1300,        // after leaving the bottom, reach the top zone within this
  dwellMs: 2200,        // or simply stay at the bottom this long
  cooldownMs: 1600,     // after a page turn
  awayMs: 1200,         // no face this long = looking away (auto-scroll waits)
  page: 0.88,           // part of a screen to move per page turn
};

// Every step and error goes to the server log as well (journalctl --user -u yt-summary),
// since a phone's console cannot be seen from there.
function report(message) {
  const key = sessionStorage.getItem('yt-summary-token') || localStorage.getItem('yt-summary-token') || '';
  fetch('/api/client-log', { method: 'POST', headers: { 'X-YT-Token': key }, body: `eye: ${message}` }).catch(() => {});
}

// A step that does not finish in time fails with a message saying which step it was.
function within(ms, label, promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took too long (over ${Math.round(ms / 1000)} s)`)), ms);
  })]).finally(() => clearTimeout(timer));
}

let landmarkerPromise = null;
function loadLandmarker(status) {
  landmarkerPromise ??= (async () => {
    status('Loading engine…');
    const t0 = performance.now();
    const { FaceLandmarker, FilesetResolver } = await within(120000, 'Downloading the engine', import(`${MP}/vision_bundle.mjs`));
    const files = await within(120000, 'Downloading the engine', FilesetResolver.forVisionTasks(`${MP}/wasm`));
    report(`engine ready in ${Math.round(performance.now() - t0)} ms`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: `${MP}/face_landmarker.task`, delegate },
      runningMode: 'VIDEO', numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    });
    // The phone's graphics chip is faster, but on some Android phones it stalls instead of
    // failing; then the CPU, which always works.
    status('Loading face model…');
    try {
      const lm = await within(30000, 'Starting on the graphics chip', FaceLandmarker.createFromOptions(files, options('GPU')));
      report(`face model ready on GPU in ${Math.round(performance.now() - t0)} ms`);
      return lm;
    } catch (error) {
      report(`GPU failed (${error.message}); trying CPU`);
      status('Loading face model (CPU)…');
      const lm = await within(120000, 'Loading the face model', FaceLandmarker.createFromOptions(files, options('CPU')));
      report(`face model ready on CPU in ${Math.round(performance.now() - t0)} ms`);
      return lm;
    }
  })();
  landmarkerPromise.catch(() => { landmarkerPromise = null; });
  return landmarkerPromise;
}

// Raw features of one frame: [iris position between the lids, look-down minus look-up, head pitch].
// Each eye is judged on its own: a closing/blinking eye is left out and the other one used, and
// when two open eyes disagree strongly the frame is skipped (unreliable) instead of averaged,
// since one badly read eye (glare on glasses, side light, a squint) made the gaze jump.
// Each eye's points (MediaPipe face mesh): iris centre, upper/lower lid, the two corners.
const EYES = [
  { iris: 468, upper: 159, lower: 145, inner: 133, outer: 33 },
  { iris: 473, upper: 386, lower: 374, inner: 362, outer: 263 },
];
function features(result) {
  const lm = result.faceLandmarks && result.faceLandmarks[0];
  if (!lm) return null;
  const shapes = {};
  for (const c of (result.faceBlendshapes && result.faceBlendshapes[0] ? result.faceBlendshapes[0].categories : [])) shapes[c.categoryName] = c.score;
  const eyes = EYES.map((e) => {
    const lidGap = lm[e.lower].y - lm[e.upper].y;
    const width = Math.hypot(lm[e.inner].x - lm[e.outer].x, lm[e.inner].y - lm[e.outer].y);
    // How open this eye is, from its own shape (no left/right naming to get wrong).
    const openness = lidGap / Math.max(1e-4, width);
    return { iris: (lm[e.iris].y - lm[e.upper].y) / Math.max(1e-4, lidGap), ok: openness > 0.10 }; // closed is ~0.05-0.08; looking down lowers the lid, so not higher
  });
  const open = eyes.filter((e) => e.ok);
  if (!open.length) return { x: null, eyes: 0 };
  if (open.length === 2 && Math.abs(open[0].iris - open[1].iris) > 0.3) return { x: null, eyes: 2, disagree: true };
  // Both eyes look up/down together, so their look scores are simply averaged.
  const look = ((shapes.eyeLookDownLeft || 0) + (shapes.eyeLookDownRight || 0) - (shapes.eyeLookUpLeft || 0) - (shapes.eyeLookUpRight || 0)) / 2;
  const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
  const pitch = m ? Math.asin(Math.max(-1, Math.min(1, -m.data[9]))) : 0; // head nod, radians
  const iris = open.reduce((a, e) => a + e.iris, 0) / open.length;
  return { x: [iris, look, pitch], eyes: open.length };
}

// Ridge regression: screen y from standardized features (works with only 3 calibration targets).
function fit(samples) {
  const n = samples.length, k = 3;
  const mean = [0, 1, 2].map((j) => samples.reduce((a, s) => a + s.x[j], 0) / n);
  const sd = [0, 1, 2].map((j) => Math.sqrt(samples.reduce((a, s) => a + (s.x[j] - mean[j]) ** 2, 0) / n) || 1);
  const z = samples.map((s) => s.x.map((v, j) => (v - mean[j]) / sd[j]));
  const ym = samples.reduce((a, s) => a + s.y, 0) / n;
  const A = [...Array(k)].map(() => Array(k).fill(0)), b = Array(k).fill(0);
  z.forEach((row, i) => { for (let p = 0; p < k; p++) { b[p] += row[p] * (samples[i].y - ym); for (let q = 0; q < k; q++) A[p][q] += row[p] * row[q]; } });
  for (let p = 0; p < k; p++) A[p][p] += 0.05 * n; // ridge
  for (let p = 0; p < k; p++) { // Gaussian elimination
    for (let r = p + 1; r < k; r++) { const f = A[r][p] / A[p][p]; for (let c = p; c < k; c++) A[r][c] -= f * A[p][c]; b[r] -= f * b[p]; }
  }
  const w = Array(k).fill(0);
  for (let p = k - 1; p >= 0; p--) { let v = b[p]; for (let c = p + 1; c < k; c++) v -= A[p][c] * w[c]; w[p] = v / A[p][p]; }
  return { mean, sd, w, ym };
}
const predict = (cal, x) => cal.ym + x.reduce((a, v, j) => a + cal.w[j] * (v - cal.mean[j]) / cal.sd[j], 0);

const el = (tag, props = {}, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children); return n; };

export async function start({ viewer, body, bar, button, label = (icon, text) => [`${icon} ${text}`], setLookingAway, onStop }) {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    throw new Error('The camera only works on the https link. Open the dashboard at https://YOUR-MACHINE.YOUR-TAILNET.ts.net:8443 and try again.');
  }
  const status = (text) => { button.textContent = `👁 ${text}`; };
  report(`start on ${navigator.userAgent}`);
  let stream = null, video = null;
  try {
    status('Starting camera…');
    stream = await within(20000, 'Starting the camera', navigator.mediaDevices.getUserMedia(
      { video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } }, audio: false }));
    // Some Android versions only deliver frames to a video element that is in the page.
    video = el('video', { muted: true, playsInline: true, autoplay: true, className: 'eye-video' });
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    viewer.append(video);
    video.play().catch(() => {});
    await within(15000, 'Getting the first camera picture', new Promise((resolve) => {
      if (video.readyState >= 2) resolve(); else video.addEventListener('loadeddata', resolve, { once: true });
    }));
    report(`camera ${video.videoWidth}x${video.videoHeight}`);
  } catch (error) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (video) video.remove();
    report(`camera failed: ${error.name || ''} ${error.message}`);
    throw new Error(`Camera: ${error.message}`);
  }
  let landmarker;
  try {
    landmarker = await loadLandmarker(status);
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    video.remove();
    report(`engine failed: ${error.message}`);
    throw new Error(`Eye tracking could not start: ${error.message}`);
  }

  // UI: status dot in the bar (gray no face, green face, blue armed), a gaze marker on the
  // left edge of the text, and a recalibrate button.
  const dot = el('span', { className: 'eye-dot', title: 'Gray: no face seen · Green: watching · Blue: ready to turn the page' });
  const recal = el('button', { type: 'button', className: 'eye-recal', title: 'Calibrate again' }, '↻');
  bar.append(dot, recal);
  const marker = el('div', { className: 'eye-marker' });
  viewer.append(marker);
  button.replaceChildren(...label('👁', 'On')); // phones show just 👁, coloured while on
  button.classList.add('on');

  let cal = null;
  try { cal = JSON.parse(localStorage.getItem(CAL_KEY)); } catch {}
  let tune = { ...TUNE_DEFAULT };
  try { tune = { ...TUNE_DEFAULT, ...JSON.parse(localStorage.getItem(TUNE_KEY) || '{}') }; } catch {}
  const saveTune = () => { try { localStorage.setItem(TUNE_KEY, JSON.stringify(tune)); } catch {} };
  // Gaze estimate (0 top .. 1 bottom): calibration fit, its measured correction (adj, from the
  // check after calibrating), then your shift/sensitivity.
  const gazeY = (x) => {
    let v = predict(cal, x);
    if (cal.adj) v = cal.adj.a * v + cal.adj.b;
    return 0.5 + tune.sensitivity * (v - 0.5) + tune.shift;
  };
  const gear = el('button', { type: 'button', className: 'eye-recal', title: 'Fine-tune the eyes' }, '⚙');
  bar.append(gear);
  let stopped = false, raf = null, lastRun = 0, y = 0.5, lastFace = 0, away = false;
  const stats = { both: 0, one: 0, disagree: 0, none: 0 }; // frames by how the eyes were read (logged)
  let collecting = null; // during calibration: { y, samples } filled by every camera frame
  let zone = 'mid', zoneSince = performance.now(), armedUntil = 0, armed = false, cooldownUntil = 0;

  function loop(now) {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (now - lastRun < 1000 / T.fps || video.readyState < 2) return;
    lastRun = now;
    let result;
    try { result = landmarker.detectForVideo(video, now); } catch { return; }
    const f = features(result);
    if (window.__eyeDebug) window.__eyeLast = f; // tuning: see the raw readings from the console
    if (f) stats[f.disagree ? 'disagree' : f.eyes === 2 ? 'both' : f.eyes === 1 ? 'one' : 'none']++;
    if (collecting && f && f.x) { const ty = collecting.at(now); if (ty !== null) collecting.samples.push({ x: f.x, y: ty }); }
    if (!f) {
      dot.className = 'eye-dot';
      if (!away && now - lastFace > T.awayMs) { away = true; setLookingAway(true); }
      return;
    }
    lastFace = now;
    if (away) { away = false; setLookingAway(false); }
    if (!cal || !f.x) { dot.className = 'eye-dot face'; return; } // a blink or unreliable eyes: no gaze this frame
    y += T.smooth * (Math.max(-0.2, Math.min(1.2, gazeY(f.x))) - y);
    const rect = body.getBoundingClientRect(), vrect = viewer.getBoundingClientRect();
    marker.style.top = `${rect.top - vrect.top + Math.max(0, Math.min(1, y)) * rect.height}px`;
    const z = y < T.topZone ? 'top' : y > tune.bottomZone ? 'bottom' : 'mid';
    if (z !== zone) {
      if (zone === 'bottom' && armed) armedUntil = now + T.swipeMs; // left the bottom: swipe window
      zone = z; zoneSince = now;
    }
    if (now < cooldownUntil) { armed = false; dot.className = 'eye-dot face'; return; }
    if (zone === 'bottom' && now - zoneSince > T.armMs) armed = true;
    if (zone === 'bottom' && now - zoneSince > tune.dwellMs) return turnPage(now, 'dwell'); // dwell fallback
    if (zone === 'top' && armed && now < armedUntil) return turnPage(now, 'swipe');         // eye-swipe
    if (zone !== 'bottom' && now > armedUntil) armed = false;
    dot.className = armed ? 'eye-dot face armed' : 'eye-dot face';
  }

  // Next page, with the line you were reading marked so the eyes find it again.
  function turnPage(now, how) {
    armed = false; cooldownUntil = now + T.cooldownMs; zoneSince = now;
    report(`page turn by ${how} at ${Math.round(100 * body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight))}% of the text`);
    const step = body.clientHeight * tune.page;
    const mark = el('div', { className: 'eye-gazemarker' });
    mark.style.top = `${body.scrollTop + body.clientHeight * 0.86}px`;
    if (getComputedStyle(body).position === 'static') body.style.position = 'relative';
    body.append(mark);
    setTimeout(() => mark.remove(), 1800);
    body.scrollBy({ top: step, behavior: 'smooth' });
    dot.className = 'eye-dot face turned';
  }

  // Calibration: follow a dot that glides slowly top -> bottom -> top (~9 s); every camera
  // frame is a sample at the dot's height (a moving target gives readings across the whole
  // screen, not just 3 points). Then a check: a dot at the top and at the bottom, how close the
  // estimate is (Good / OK / Poor), and the measured offset is corrected automatically.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function calibrate() {
    const text = el('p', {}, 'Follow the dot with your eyes');
    const overlay = el('div', { className: 'eye-cal' }, text);
    const target = el('span', { className: 'eye-cal-dot glide' });
    overlay.append(target);
    viewer.append(overlay);
    const samples = [];
    const TOP = 0.1, BOTTOM = 0.9, HOLD = 900, GLIDE = 3200, LAG = 150; // eyes trail a moving dot ~150 ms
    const path = (t) => { // dot height at t ms after the start
      const legs = [[HOLD, TOP, TOP], [GLIDE, TOP, BOTTOM], [HOLD, BOTTOM, BOTTOM], [GLIDE, BOTTOM, TOP], [HOLD, TOP, TOP]];
      for (const [ms, from, to] of legs) { if (t < ms) return from + (to - from) * (0.5 - Math.cos(Math.PI * t / ms) / 2); t -= ms; }
      return null;
    };
    const total = 3 * HOLD + 2 * GLIDE;
    try {
      target.style.top = `${TOP * 100}%`;
      await sleep(800); // find the dot
      const t0 = performance.now();
      collecting = { samples, at: (now) => (now - t0 > 500 ? path(now - t0 - LAG) : null) };
      while (performance.now() - t0 < total && !stopped) {
        target.style.top = `${path(performance.now() - t0) * 100}%`;
        await new Promise((r) => requestAnimationFrame(r));
      }
      collecting = null;
      report(`calibration: ${samples.length} samples`);
      if (samples.length < 25) throw new Error('Your face was not seen well enough. Hold the phone in front of you, in good light, and try again.');
      cal = fit(samples);

      // The check: where does it think you look, for a dot at the top and at the bottom?
      text.textContent = 'Now look at the dot';
      target.classList.remove('glide');
      const measured = {};
      for (const ty of [0.15, 0.85]) {
        target.style.top = `${ty * 100}%`;
        await sleep(700);
        const got = [];
        collecting = { samples: got, at: () => ty };
        await sleep(1300);
        collecting = null;
        measured[ty] = got.length ? got.reduce((a, s) => a + predict(cal, s.x), 0) / got.length : null;
      }
      const pTop = measured[0.15], pBottom = measured[0.85];
      if (pTop === null || pBottom === null) throw new Error('Your face was not seen during the check. Try again.');
      const error = (Math.abs(pTop - 0.15) + Math.abs(pBottom - 0.85)) / 2;
      const spread = pBottom - pTop; // must clearly tell top from bottom
      const grade = spread < 0.25 ? 'Poor' : error < 0.1 && spread > 0.5 ? 'Good' : error < 0.2 ? 'OK' : 'Poor';
      // Map what was measured exactly onto the two dots (fixes a steady shift or squeeze).
      if (spread > 0.15) { const a = 0.7 / spread; cal.adj = { a, b: 0.15 - a * pTop }; }
      report(`calibration check: ${grade} (top read ${pTop.toFixed(2)}, bottom ${pBottom.toFixed(2)}, error ${error.toFixed(2)})`);
      try { localStorage.setItem(CAL_KEY, JSON.stringify(cal)); } catch {}

      text.textContent = grade === 'Good' ? '✓ Calibration: Good'
        : grade === 'OK' ? 'Calibration: OK. Fine-tune with ⚙ if pages turn early or late.'
          : 'Calibration: Poor. Better light, the phone steady in front of your face, then ↻ to redo.';
      target.remove();
      await sleep(grade === 'Good' ? 1200 : 2600);
    } finally { collecting = null; overlay.remove(); }
  }

  // ⚙ Fine-tune: sliders with the gaze marker moving live, saved on this phone.
  function tunePanel() {
    if (viewer.querySelector('.eye-tune')) return;
    const row = (label, key, min, max, step, show) => {
      const out = el('b', {}, show(tune[key]));
      const input = el('input', { type: 'range', min, max, step, value: String(tune[key]) });
      input.addEventListener('input', () => { tune[key] = Number(input.value); out.textContent = show(tune[key]); saveTune(); });
      return el('label', {}, el('span', {}, label), input, out);
    };
    const pct = (v) => `${Math.round(v * 100)}%`;
    const panel = el('div', { className: 'eye-tune' },
      el('p', {}, 'Look at the text: the green mark on the left follows your eyes. Adjust until it matches.'),
      row('Shift (marker too high → move right)', 'shift', -0.3, 0.3, 0.01, (v) => (v > 0 ? '+' : '') + Math.round(v * 100)),
      row('Sensitivity', 'sensitivity', 0.5, 2, 0.05, (v) => `×${v.toFixed(2)}`),
      row('Bottom zone starts at', 'bottomZone', 0.55, 0.9, 0.01, pct),
      row('Hold at the bottom to turn', 'dwellMs', 1000, 4000, 100, (v) => `${(v / 1000).toFixed(1)} s`),
      row('Page turn size', 'page', 0.5, 0.95, 0.01, pct));
    const reset = el('button', { type: 'button' }, 'Reset');
    const done = el('button', { type: 'button', className: 'eye-tune-done' }, 'Done');
    reset.addEventListener('click', () => { tune = { ...TUNE_DEFAULT }; saveTune(); panel.remove(); tunePanel(); });
    done.addEventListener('click', () => { panel.remove(); report(`tuning saved ${JSON.stringify(tune)}`); });
    panel.append(el('div', { className: 'eye-tune-buttons' }, reset, done));
    viewer.append(panel);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    clearInterval(statsTimer);
    stream.getTracks().forEach((t) => t.stop());
    video.remove(); dot.remove(); recal.remove(); gear.remove(); marker.remove(); viewer.querySelector('.eye-tune')?.remove();
    button.replaceChildren(...label('👁', 'Eyes'));
    button.classList.remove('on');
    if (away) setLookingAway(false);
    onStop();
  }

  const statsTimer = setInterval(() => {
    const total = stats.both + stats.one + stats.disagree + stats.none;
    if (total) report(`eyes over the last minute: both ${stats.both}, one ${stats.one}, eyes disagreed ${stats.disagree}, closed ${stats.none} (of ${total} frames)`);
    Object.keys(stats).forEach((k) => { stats[k] = 0; });
  }, 60000);
  raf = requestAnimationFrame(loop);
  recal.addEventListener('click', () => calibrate().catch((e) => alert(e.message)));
  gear.addEventListener('click', tunePanel);
  if (!cal) {
    try { await calibrate(); } catch (e) { stop(); throw e; }
  }
  return { stop };
}

export const _test = { features, fit, predict, T };
