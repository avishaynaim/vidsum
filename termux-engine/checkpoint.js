'use strict';
// Durable, resumable checkpoint storage for the Termux engine. Mirrors the Windows engine's
// requirements: atomic persistence, transcript identity/hash binding so a restart never
// mixes transcript/settings, provider provenance, and a rotation cursor.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHECKPOINT_DIR = process.env.YT_TERMUX_CHECKPOINT_DIR ||
  path.join(require('os').homedir(), '.yt-summary-termux', 'checkpoints');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function transcriptHash(transcript) {
  return crypto.createHash('sha256').update(transcript, 'utf8').digest('hex');
}

function checkpointPath(videoId) {
  return path.join(CHECKPOINT_DIR, `${videoId}.json`);
}

// Atomic write: write to a temp file in the same directory, then rename over the target.
// Rename is atomic on the same filesystem, so a crash mid-write never leaves a corrupt
// checkpoint - the reader always sees either the old or the new complete file.
function atomicWriteJson(targetPath, data) {
  ensureDir(path.dirname(targetPath));
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

function loadCheckpoint(videoId) {
  const file = checkpointPath(videoId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A corrupt/partial checkpoint (e.g. from a killed process before atomic rename
    // completed a *previous* generation) must not crash a restart; treat as absent so
    // the caller starts fresh rather than resuming from garbage.
    return null;
  }
}

// Initializes (or reuses, if transcript/settings match) a checkpoint for a video.
function initCheckpoint({ videoId, transcript, summaryLevel, firstProvider, plan }) {
  const hash = transcriptHash(transcript);
  const existing = loadCheckpoint(videoId);
  if (existing && existing.transcriptHash === hash && existing.summaryLevel === summaryLevel) {
    return existing;
  }
  // Settings or transcript changed (or no checkpoint yet): start a clean, fresh checkpoint
  // rather than mixing old parts with a different transcript/level.
  const fresh = {
    videoId,
    transcriptHash: hash,
    summaryLevel,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isChunked: plan.isChunked,
    totalChunks: plan.isChunked ? plan.chunks.length : 0,
    parts: [], // [{ index, provider, text }]
    mergeParts: [], // intermediate merge-stage results, if a merge tree is needed
    finalResult: null,
    rotationCursor: firstProvider || 'ChatGPT',
    stage: plan.isChunked ? 'chunks' : 'single',
  };
  atomicWriteJson(checkpointPath(videoId), fresh);
  return fresh;
}

function saveCheckpoint(checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  atomicWriteJson(checkpointPath(checkpoint.videoId), checkpoint);
}

function transcriptCachePath(videoId) {
  return path.join(CHECKPOINT_DIR, `${videoId}.transcript.txt`);
}

// Clears both the checkpoint and its private transcript cache - the "clear local progress"
// control. Safe to call even if one or both files are already absent.
function clearCheckpoint(videoId) {
  const file = checkpointPath(videoId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const transcriptFile = transcriptCachePath(videoId);
  if (fs.existsSync(transcriptFile)) fs.unlinkSync(transcriptFile);
}

// Privately caches the fetched transcript beside the checkpoint so a restart resumes
// without re-fetching it (mirrors the Windows engine's per-video split-transcript cache).
// Deleted on completion or when the user clears progress - never kept beyond that.
function saveTranscriptCache(videoId, text) {
  ensureDir(CHECKPOINT_DIR);
  const target = transcriptCachePath(videoId);
  const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, target);
  try { fs.chmodSync(target, 0o600); } catch { /* best-effort on filesystems without POSIX perms */ }
}

function loadTranscriptCache(videoId) {
  const file = transcriptCachePath(videoId);
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function clearTranscriptCache(videoId) {
  const file = transcriptCachePath(videoId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = {
  transcriptHash, initCheckpoint, loadCheckpoint, saveCheckpoint, clearCheckpoint, CHECKPOINT_DIR,
  saveTranscriptCache, loadTranscriptCache, clearTranscriptCache,
};
