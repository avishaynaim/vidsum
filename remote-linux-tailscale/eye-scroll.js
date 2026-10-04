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
function features(result) {
  const lm = result.faceLandmarks && result.faceLandmarks[0];
  if (!lm) return null;
  const lid = (iris, upper, lower) => (lm[iris].y - lm[upper].y) / Math.max(1e-4, lm[lower].y - lm[upper].y);
  const iris = (lid(468, 159, 145) + lid(473, 386, 374)) / 2;
  const shapes = {};
  for (const c of (result.faceBlendshapes && result.faceBlendshapes[0] ? result.faceBlendshapes[0].categories : [])) shapes[c.categoryName] = c.score;
  const look = ((shapes.eyeLookDownLeft || 0) + (shapes.eyeLookDownRight || 0) - (shapes.eyeLookUpLeft || 0) - (shapes.eyeLookUpRight || 0)) / 2;
  const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
  const pitch = m ? Math.asin(Math.max(-1, Math.min(1, -m.data[9]))) : 0; // head nod, radians
  const blink = ((shapes.eyeBlinkLeft || 0) + (shapes.eyeBlinkRight || 0)) / 2;
  return { x: [iris, look, pitch], blink };
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

export async function start({ viewer, body, bar, button, setLookingAway, onStop }) {
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
  button.textContent = '👁 On';
  button.classList.add('on');

  let cal = null;
  try { cal = JSON.parse(localStorage.getItem(CAL_KEY)); } catch {}
  let stopped = false, raf = null, lastRun = 0, y = 0.5, lastFace = 0, away = false;
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
    if (collecting && f && f.blink < 0.5) collecting.samples.push({ x: f.x, y: collecting.y });
    if (!f) {
      dot.className = 'eye-dot';
      if (!away && now - lastFace > T.awayMs) { away = true; setLookingAway(true); }
      return;
    }
    lastFace = now;
    if (away) { away = false; setLookingAway(false); }
    if (!cal || f.blink > 0.5) { dot.className = 'eye-dot face'; return; } // a blink is no gaze
    y += T.smooth * (Math.max(-0.2, Math.min(1.2, predict(cal, f.x))) - y);
    const rect = body.getBoundingClientRect(), vrect = viewer.getBoundingClientRect();
    marker.style.top = `${rect.top - vrect.top + Math.max(0, Math.min(1, y)) * rect.height}px`;
    const z = y < T.topZone ? 'top' : y > T.bottomZone ? 'bottom' : 'mid';
    if (z !== zone) {
      if (zone === 'bottom' && armed) armedUntil = now + T.swipeMs; // left the bottom: swipe window
      zone = z; zoneSince = now;
    }
    if (now < cooldownUntil) { armed = false; dot.className = 'eye-dot face'; return; }
    if (zone === 'bottom' && now - zoneSince > T.armMs) armed = true;
    if (zone === 'bottom' && now - zoneSince > T.dwellMs) return turnPage(now); // dwell fallback
    if (zone === 'top' && armed && now < armedUntil) return turnPage(now);       // eye-swipe
    if (zone !== 'bottom' && now > armedUntil) armed = false;
    dot.className = armed ? 'eye-dot face armed' : 'eye-dot face';
  }

  // Next page, with the line you were reading marked so the eyes find it again.
  function turnPage(now) {
    armed = false; cooldownUntil = now + T.cooldownMs; zoneSince = now;
    const step = body.clientHeight * T.page;
    const mark = el('div', { className: 'eye-gazemarker' });
    mark.style.top = `${body.scrollTop + body.clientHeight * 0.86}px`;
    if (getComputedStyle(body).position === 'static') body.style.position = 'relative';
    body.append(mark);
    setTimeout(() => mark.remove(), 1800);
    body.scrollBy({ top: step, behavior: 'smooth' });
    dot.className = 'eye-dot face turned';
  }

  // 3-dot calibration: look at each dot for ~1.5 s (top, middle, bottom).
  async function calibrate() {
    const overlay = el('div', { className: 'eye-cal' }, el('p', {}, 'Look at the dot until it moves'));
    const target = el('span', { className: 'eye-cal-dot' });
    overlay.append(target);
    viewer.append(overlay);
    const samples = [];
    try {
      for (const ty of [0.12, 0.5, 0.88]) {
        target.style.top = `${ty * 100}%`;
        await new Promise((r) => setTimeout(r, 700)); // eyes travel
        collecting = { y: ty, samples };
        await new Promise((r) => setTimeout(r, 1300));
        collecting = null;
      }
    } finally { collecting = null; overlay.remove(); }
    report(`calibration: ${samples.length} samples`);
    if (samples.length < 12) throw new Error('Your face was not seen well enough. Hold the phone in front of you, in good light, and try again.');
    cal = fit(samples);
    try { localStorage.setItem(CAL_KEY, JSON.stringify(cal)); } catch {}
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    video.remove(); dot.remove(); recal.remove(); marker.remove();
    button.textContent = '👁 Eyes';
    button.classList.remove('on');
    if (away) setLookingAway(false);
    onStop();
  }

  raf = requestAnimationFrame(loop);
  recal.addEventListener('click', () => calibrate().catch((e) => alert(e.message)));
  if (!cal) {
    try { await calibrate(); } catch (e) { stop(); throw e; }
  }
  return { stop };
}

export const _test = { features, fit, predict, T };
