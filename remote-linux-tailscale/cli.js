#!/usr/bin/env node
'use strict';
// remote-linux-tailscale/cli.js
//
// *** EXPERIMENTAL / UNVERIFIED - see README.md ***
// Ported orchestration logic (chunking, prompts, rejection classification, rotation,
// checkpointing) faithfully from TranscriptChunks.psm1 / Providers.psm1 / YtSummary.psm1.
// The provider send/reply plumbing (send.js, cdp.js) has never been run against a real
// device or a live ChatGPT/Gemini/Claude page - only unit-level (`node --check`, and the
// pure logic in rejections.js/chunk.js) has been exercised. Treat this as ready-to-debug,
// not ready-to-trust, until you've run it live and confirmed selectors match mobile Chrome.
//
// Usage:
//   node cli.js <videoId> [--level ultra|max|reg|min|micro|full|legacy] [--first-provider ChatGPT|Gemini|Claude]
//              [--out <dir>] [--clear] [--max-message-chars N]
//
// Resumable by design: re-running the same videoId with the same level reuses the saved
// checkpoint and never redoes completed chunk/merge stages (see checkpoint.js). Pass
// --clear to wipe that video's saved progress/transcript cache first.

const fs = require('fs');
const path = require('path');

const transcriptMod = require('./transcript');
const chunk = require('./chunk');
const checkpointMod = require('./checkpoint');
const rotate = require('./rotate');

function parseArgs(argv) {
  const args = { level: 'legacy', firstProvider: null, out: process.cwd(), clear: false, maxMessageChars: 22000 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--level') args.level = argv[++i];
    else if (a === '--first-provider') args.firstProvider = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--clear') args.clear = true;
    else if (a === '--max-message-chars') args.maxMessageChars = parseInt(argv[++i], 10);
    else positional.push(a);
  }
  args.videoId = positional[0];
  return args;
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

// Recomputes the transcript plan for the current settings. Deterministic given the same
// transcript text + level + maxMessageChars, so it is safe to recompute on every resume
// instead of persisting the (potentially large) prompt text itself in the checkpoint.
function buildPlan(transcriptText, videoId, level, title, maxMessageChars) {
  return chunk.getTranscriptPlan({
    transcript: transcriptText,
    videoId,
    maxMessageCharacters: maxMessageChars,
    summaryLevel: level,
    language: 'auto',
    title,
  });
}

async function runChunkedStages(ckpt, plan, videoId, level, title, onStatus) {
  const doneIndexes = new Set(ckpt.parts.map((p) => p.index));
  for (let i = 0; i < plan.chunks.length; i++) {
    const index = i + 1;
    if (doneIndexes.has(index)) continue; // already completed - never redo a finished part
    onStatus(`Chunk part ${index}/${plan.chunks.length}: starting.`);
    let result;
    try {
      result = await rotate.runStage(ckpt, plan.chunkPrompts[i], { onStatus });
    } catch (err) {
      checkpointMod.saveCheckpoint(ckpt); // persist rotation cursor progress even on failure
      if (err instanceof rotate.AllProvidersFailedError && err.allSize && ckpt.parts.length === 0) {
        // Adaptive re-chunk: only safe when NO parts have completed yet for this video,
        // since re-chunking now would misalign already-saved part indexes against a new
        // split. Signal the caller to retry with a smaller budget.
        throw Object.assign(new Error('adaptive-rechunk-needed'), { adaptiveRechunk: true });
      }
      // Later size failure (some parts already done), or a non-size exhaustion: preserve
      // progress and stop retryably rather than silently corrupting or discarding work.
      throw Object.assign(new Error(`Chunk part ${index} failed on every provider: ${err.message}`), { retryable: true });
    }
    ckpt.parts.push({ index, provider: result.provider, text: result.text });
    checkpointMod.saveCheckpoint(ckpt);
    onStatus(`Chunk part ${index}/${plan.chunks.length}: done via ${result.provider}.`);
  }
}

async function mergeStage(ckpt, videoId, level, title, onStatus) {
  if (ckpt.finalResult) return ckpt.finalResult;
  const orderedTexts = ckpt.parts.slice().sort((a, b) => a.index - b.index).map((p) => p.text);
  if (orderedTexts.length === 1) {
    // Single chunk: still route it through one more rotation stage as the "final" pass,
    // matching the original tool's part->final flow (light touch-up / verbatim-join per
    // level), rather than silently emitting the raw part as the final answer.
    const prompt = chunk.newCombinePrompt({ summaries: orderedTexts, videoId, final: true, summaryLevel: level, language: 'auto', title });
    const result = await rotate.runStage(ckpt, prompt, { onStatus });
    ckpt.finalResult = { text: result.text, provider: result.provider };
    checkpointMod.saveCheckpoint(ckpt);
    return ckpt.finalResult;
  }
  const prompt = chunk.newCombinePrompt({ summaries: orderedTexts, videoId, final: true, summaryLevel: level, language: 'auto', title });
  const result = await rotate.runStage(ckpt, prompt, { onStatus });
  ckpt.finalResult = { text: result.text, provider: result.provider };
  checkpointMod.saveCheckpoint(ckpt);
  return ckpt.finalResult;
}

// Runs the full transcript -> chunk/rotate -> merge pipeline for one video and returns the
// final result. This is the single production entry point for the pipeline: both the CLI's
// `main()` below and server.js's job runner call this exact function, so a remote/queued run
// (e.g. triggered over Tailscale from server.js) exercises the identical, already-tested
// logic as running `node cli.js` directly - never a second parallel implementation.
async function runVideo(args, onStatus) {
  transcriptMod.assertValidVideoId(args.videoId);
  onStatus = onStatus || ((msg) => log(`[${args.videoId}]`, msg));

  if (args.clear) {
    checkpointMod.clearCheckpoint(args.videoId);
    onStatus(`Cleared saved progress and transcript cache for ${args.videoId}.`);
  }

  // Resume without re-fetching if a private transcript cache already exists.
  let transcriptText = checkpointMod.loadTranscriptCache(args.videoId);
  let title = args.videoId;
  if (!transcriptText) {
    onStatus('Fetching transcript...');
    const fetched = await transcriptMod.fetchTranscript(args.videoId);
    transcriptText = fetched.text;
    title = fetched.title;
    checkpointMod.saveTranscriptCache(args.videoId, transcriptText);
    onStatus(`Transcript fetched (${transcriptText.length} chars).`);
  } else {
    onStatus(`Reusing cached transcript (${transcriptText.length} chars) - resuming without re-fetch.`);
  }

  let maxMessageChars = args.maxMessageChars;
  let plan = buildPlan(transcriptText, args.videoId, args.level, title, maxMessageChars);
  let ckpt = checkpointMod.initCheckpoint({
    videoId: args.videoId,
    transcript: transcriptText,
    summaryLevel: args.level,
    firstProvider: args.firstProvider,
    plan,
  });

  if (ckpt.finalResult) {
    onStatus('Checkpoint already has a final result; nothing to do. Pass --clear to redo.');
  } else if (!plan.isChunked) {
    if (ckpt.parts.length === 0) {
      const result = await rotate.runStage(ckpt, plan.singlePrompt, { onStatus });
      ckpt.parts.push({ index: 1, provider: result.provider, text: result.text });
      checkpointMod.saveCheckpoint(ckpt);
    }
    ckpt.finalResult = { text: ckpt.parts[0].text, provider: ckpt.parts[0].provider };
    checkpointMod.saveCheckpoint(ckpt);
  } else {
    try {
      await runChunkedStages(ckpt, plan, args.videoId, args.level, title, onStatus);
    } catch (err) {
      if (err.adaptiveRechunk) {
        const smallerChars = Math.max(4000, Math.floor(maxMessageChars / 2));
        onStatus(`Every provider rejected the first chunk as too large; adaptively re-chunking with a smaller budget (${maxMessageChars} -> ${smallerChars}) since no parts have completed yet.`);
        maxMessageChars = smallerChars;
        plan = buildPlan(transcriptText, args.videoId, args.level, title, maxMessageChars);
        ckpt = checkpointMod.initCheckpoint({
          videoId: args.videoId, transcript: transcriptText, summaryLevel: args.level,
          firstProvider: ckpt.rotationCursor, plan,
        });
        await runChunkedStages(ckpt, plan, args.videoId, args.level, title, onStatus);
      } else {
        // Preserve progress and surface a retryable stop, rather than throwing raw - the
        // caller (CLI or server.js) decides how to report/exit.
        throw Object.assign(new Error(`STOPPED (retryable): ${err.message}`), { retryable: true, videoId: args.videoId });
      }
    }
    await mergeStage(ckpt, args.videoId, args.level, title, onStatus);
  }

  fs.mkdirSync(args.out, { recursive: true });
  const outFile = path.join(args.out, `${args.videoId}.summary.txt`);
  fs.writeFileSync(outFile, ckpt.finalResult.text, 'utf8');
  onStatus(`Final summary (via ${ckpt.finalResult.provider}) written to ${outFile}`);

  // The transcript no longer needs to be retained privately once the video is complete.
  checkpointMod.clearTranscriptCache(args.videoId);

  return { outFile, text: ckpt.finalResult.text, provider: ckpt.finalResult.provider };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.videoId) {
    console.error('Usage: node cli.js <videoId> [--level ultra|max|reg|min|micro|full|legacy] [--first-provider ChatGPT|Gemini|Claude] [--out <dir>] [--clear]');
    process.exit(1);
  }

  const onStatus = (msg) => log(`[${args.videoId}]`, msg);
  try {
    await runVideo(args, onStatus);
  } catch (err) {
    if (err.retryable) {
      log(err.message);
      log(`Progress is preserved. Re-run the same command to retry from the saved checkpoint (${checkpointMod.CHECKPOINT_DIR}).`);
      process.exit(2);
    }
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runVideo, parseArgs };
