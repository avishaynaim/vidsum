'use strict';
// remote-linux-tailscale/whisper.js
//
// Last-resort transcript for a video with no captions anywhere on YouTube, when the NotebookLM
// audio transcription (transcript.js) also failed: download the audio with yt-dlp and
// transcribe it with Whisper (large-v3-turbo; Hebrew by default).
//
// Two engines:
//   - modal (preferred): a GPU on Modal's free tier, see modal-whisper/. Only a small audio file
//     leaves this box; an hour of audio takes a couple of minutes. Used when ~/.modal.toml exists.
//   - local: whisper.cpp on this box. It is a 4-core Celeron J4125 without AVX, so that is 30-60x
//     slower than the audio itself.
// WHISPER_ENGINE=modal|local forces one. Either way: one transcription at a time (a second video
// that needs it is told `whisperBusy` and goes back to the queue instead of holding a slot), and
// the dashboard can switch it off (settings.whisperFallback).
//
// Local setup (once): whisper.cpp built at ~/opt/whisper.cpp (build/bin/whisper-cli) and
// models/ggml-large-v3-turbo.bin there; ffmpeg on PATH. Override with WHISPER_CLI /
// WHISPER_MODEL / WHISPER_LANGUAGE / WHISPER_THREADS.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_WHISPER = path.join(os.homedir(), 'opt', 'whisper.cpp');
// Audio the NotebookLM path already downloaded is reused instead of fetched again.
const YT_TRANSCRIPT_AUDIO = path.join(os.homedir(), '.cache', 'yt-transcript', 'audio');
const MODAL_DIR = path.join(__dirname, 'modal-whisper');

function whisperEngine(env = process.env) {
  if (env.WHISPER_ENGINE === 'modal' || env.WHISPER_ENGINE === 'local') return env.WHISPER_ENGINE;
  return fs.existsSync(path.join(os.homedir(), '.modal.toml')) || env.MODAL_TOKEN_ID ? 'modal' : 'local';
}

function whisperPaths(env = process.env) {
  return {
    cli: env.WHISPER_CLI || path.join(HOME_WHISPER, 'build', 'bin', 'whisper-cli'),
    model: env.WHISPER_MODEL || path.join(HOME_WHISPER, 'models', 'ggml-large-v3-turbo.bin'),
    language: env.WHISPER_LANGUAGE || 'he',
    threads: String(Number(env.WHISPER_THREADS) || 3),
  };
}

// '' when everything is in place, else what is missing.
function whisperMissing(paths = whisperPaths(), engine = whisperEngine()) {
  const missing = [];
  if (engine === 'modal') {
    if (!fs.existsSync(path.join(MODAL_DIR, '.venv', 'bin', 'python'))) missing.push(`the Modal client (cd ${MODAL_DIR} && uv sync)`);
    return missing.join(', ');
  }
  if (!fs.existsSync(paths.cli)) missing.push(`whisper-cli (${paths.cli})`);
  if (!fs.existsSync(paths.model)) missing.push(`model (${paths.model})`);
  return missing.join(', ');
}

function run(cmd, args, { onLine = null, timeoutMs = 0, signal = null, onStdout = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(Object.assign(new Error('Stopped.'), { stopped: true })); return; }
    // nice 19: Whisper must never starve the browser the summaries run in.
    // Its own process group, so a stop ends it and anything it started.
    const child = spawn('nice', ['-n', '19', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    // Stop / Pause all end it at once (it used to keep running for hours after a pause).
    const onAbort = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let err = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    const lines = (chunk) => { if (onLine) String(chunk).split(/\r?\n/).forEach((l) => l && onLine(l)); };
    child.stdout.on('data', (chunk) => { if (onStdout) onStdout(chunk); else lines(chunk); });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4000); lines(chunk); });
    child.on('error', reject);
    child.on('close', (code, killSignal) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) reject(Object.assign(new Error('Stopped.'), { stopped: true }));
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} ${killSignal ? `was killed (${killSignal})` : `exited with ${code}`}: ${err.trim().split('\n').pop() || ''}`));
    });
  });
}

let busy = false;

/**
 * Transcribes `videoId` locally. Throws `{ whisperBusy: true }` at once if another video is
 * already being transcribed. deps.findYtDlp: transcript.js's yt-dlp lookup.
 */
async function transcribeWithWhisper(videoId, { onStatus = () => {}, findYtDlp, signal = null } = {}) {
  const paths = whisperPaths();
  const engine = whisperEngine();
  const missing = whisperMissing(paths, engine);
  if (missing) throw new Error(`Whisper (${engine}) is not set up (missing ${missing})`);
  if (busy) throw Object.assign(new Error('The speech-to-text engine is busy with another video.'), { whisperBusy: true });
  busy = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-summary-whisper-'));
  try {
    let audio = fs.existsSync(YT_TRANSCRIPT_AUDIO) &&
      fs.readdirSync(YT_TRANSCRIPT_AUDIO).find((f) => f.startsWith(`${videoId}.`) && !f.endsWith('.json'));
    audio = audio ? path.join(YT_TRANSCRIPT_AUDIO, audio) : null;
    if (!audio) {
      const ytDlp = findYtDlp && findYtDlp();
      if (!ytDlp) throw new Error('yt-dlp is not installed on the server');
      onStatus('Local speech-to-text: downloading the audio...');
      await run(ytDlp, ['--no-warnings', '--no-playlist', '--js-runtimes', `node:${process.execPath}`,
        '-f', 'ba[ext=m4a]/ba', '-S', '+abr', '-o', path.join(dir, 'audio.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`], { timeoutMs: 30 * 60 * 1000, signal });
      audio = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('audio.')));
    }
    if (engine === 'modal') return { ...await transcribeOnModal(audio, dir, paths.language, { onStatus, signal }), title: videoId };
    const wav = path.join(dir, 'audio.wav');
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', audio, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
      { timeoutMs: 30 * 60 * 1000, signal });
    onStatus('Local speech-to-text (Whisper) started. On this server it takes several times the video length.');
    let last = -1;
    await run(paths.cli, ['-m', paths.model, '-l', paths.language, '-t', paths.threads, '-pp', '-nt',
      '-otxt', '-of', path.join(dir, 'out'), '-f', wav], {
      timeoutMs: 48 * 3600 * 1000, signal,
      onLine: (line) => {
        const m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m && Number(m[1]) >= last + 5) {
          last = Number(m[1]);
          onStatus(`Local speech-to-text (Whisper): ${last}% done.`);
        }
      },
    });
    const text = fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('Whisper produced no text');
    return { text, title: videoId, durationSeconds: 0 };
  } finally {
    busy = false;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Sends a 16 kHz mono Opus copy (~11 MB per hour) to the Modal app and returns its text.
async function transcribeOnModal(audio, dir, language, { onStatus, signal }) {
  const small = path.join(dir, 'audio.ogg');
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', audio, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', small],
    { timeoutMs: 30 * 60 * 1000, signal });
  onStatus('Speech-to-text on a cloud GPU (Whisper on Modal): uploading, then about 1-3 minutes per hour of audio...');
  let out = '';
  await run(path.join(MODAL_DIR, '.venv', 'bin', 'python'), [path.join(MODAL_DIR, 'client.py'), small, language], {
    timeoutMs: 75 * 60 * 1000, signal, onStdout: (chunk) => { out += chunk; },
  });
  const result = JSON.parse(out.trim().split('\n').pop());
  const text = String(result.text || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Whisper on Modal produced no text');
  onStatus(`Speech-to-text done on Modal (${Math.round(result.duration / 60)} min of audio in ${Math.round(result.seconds)} s).`);
  return { text, durationSeconds: Number(result.duration) || 0 };
}

module.exports = { transcribeWithWhisper, whisperPaths, whisperMissing, whisperEngine, isWhisperBusy: () => busy };
