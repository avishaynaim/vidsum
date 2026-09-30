'use strict';
// termux-engine self-tests: exercises only the pure, network/device-free logic (rejection
// classification, chunking/prompt-building, atomic checkpoint persistence, rotation
// cursor math) since that is everything in this folder that CAN be verified without a real
// Android device, network access, or a live ChatGPT/Gemini/Claude page. send.js/cdp.js/
// transcript.js remain unverified beyond `node --check` (see README.md).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}`);
    console.error(err.stack || err.message);
  }
}

// --- rejections.js ---------------------------------------------------------
const { classifyFailure, isDefiniteRejection, isBenignBanner } = require('../termux-engine/rejections');

test('classifies "Too many requests" as a definite usage rejection', () => {
  const c = classifyFailure('Too many requests, please try again later.');
  assert.strictEqual(c, 'usage');
  assert.strictEqual(isDefiniteRejection(c), true);
});

test('classifies curly-apostrophe "making requests too quickly" as usage', () => {
  const c = classifyFailure('You\u2019re making requests too quickly. Please slow down.');
  assert.strictEqual(c, 'usage');
});

test('classifies straight-apostrophe "making requests too quickly" as usage', () => {
  const c = classifyFailure("You're making requests too fast.");
  assert.strictEqual(c, 'usage');
});

test('classifies "temporarily limited" as usage', () => {
  const c = classifyFailure('This model is temporarily limited for your account.');
  assert.strictEqual(c, 'usage');
});

test('benign "limited access to your conversations" banner is not a rejection', () => {
  assert.strictEqual(isBenignBanner('We have temporarily limited access to your conversations to protect your data.'), true);
  assert.strictEqual(classifyFailure('We have temporarily limited access to your conversations to protect your data.'), '');
});

test('classifies a size/length rejection distinctly from usage', () => {
  const c = classifyFailure('Your message is too long. Please shorten it.');
  assert.strictEqual(c, 'size');
  assert.strictEqual(isDefiniteRejection(c), true);
});

test('classifies an unavailable/capacity rejection distinctly', () => {
  const c = classifyFailure('The service is at capacity right now.');
  assert.strictEqual(c, 'unavailable');
});

test('ambiguous generic error text classifies as "service", not definite', () => {
  const c = classifyFailure('Something went wrong.', true);
  assert.strictEqual(c, 'service');
  assert.strictEqual(isDefiniteRejection(c), false);
});

test('healthy/empty text has no classification', () => {
  assert.strictEqual(classifyFailure(''), '');
  assert.strictEqual(classifyFailure('Here is your summary...'), '');
});

// --- chunk.js ----------------------------------------------------------------
const chunk = require('../termux-engine/chunk');

test('splitText preserves the complete source when rejoined', () => {
  const text = 'word '.repeat(2000).trim();
  const parts = chunk.splitText(text, 500);
  assert.strictEqual(parts.join(''), text);
  for (const part of parts) assert.ok(part.length <= 500);
});

test('splitText prefers whitespace boundaries over mid-word splits', () => {
  const text = 'aaaa bbbb cccc dddd eeee';
  const parts = chunk.splitText(text, 10);
  for (const part of parts.slice(0, -1)) {
    assert.ok(/\s$/.test(part) || part.length === 10, `unexpected split boundary: "${part}"`);
  }
});

test('getTranscriptPlan returns unchunked for short transcripts', () => {
  const plan = chunk.getTranscriptPlan({ transcript: 'short transcript text', videoId: 'AAAAAAAAAAA', summaryLevel: 'legacy' });
  assert.strictEqual(plan.isChunked, false);
  assert.ok(plan.singlePrompt.includes('short transcript text'));
});

test('getTranscriptPlan chunks a long transcript and every part prompt fits the budget', () => {
  const longText = ('the quick brown fox jumps over the lazy dog. ').repeat(3000);
  const plan = chunk.getTranscriptPlan({ transcript: longText, videoId: 'AAAAAAAAAAA', maxMessageCharacters: 22000, summaryLevel: 'reg' });
  assert.strictEqual(plan.isChunked, true);
  assert.ok(plan.chunks.length > 1);
  assert.strictEqual(plan.chunks.join(''), longText);
  for (const prompt of plan.chunkPrompts) assert.ok(prompt.length <= 22000);
});

test('newCombinePrompt includes every supplied note', () => {
  const prompt = chunk.newCombinePrompt({ summaries: ['note one', 'note two'], videoId: 'AAAAAAAAAAA', final: true, summaryLevel: 'legacy' });
  assert.ok(prompt.includes('note one'));
  assert.ok(prompt.includes('note two'));
});

// --- checkpoint.js -------------------------------------------------------------
// Point the module at an isolated temp directory before requiring it, so tests never
// touch a real ~/.yt-summary-termux directory.
const tmpCheckpointDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-termux-ckpt-'));
process.env.YT_TERMUX_CHECKPOINT_DIR = tmpCheckpointDir;
delete require.cache[require.resolve('../termux-engine/checkpoint')];
const checkpointMod = require('../termux-engine/checkpoint');

test('initCheckpoint creates a fresh checkpoint and saveCheckpoint/loadCheckpoint round-trip', () => {
  const plan = { isChunked: true, chunks: ['a', 'b'] };
  const ckpt = checkpointMod.initCheckpoint({ videoId: 'BBBBBBBBBBB', transcript: 'hello world', summaryLevel: 'legacy', firstProvider: 'Gemini', plan });
  assert.strictEqual(ckpt.rotationCursor, 'Gemini');
  assert.strictEqual(ckpt.parts.length, 0);
  ckpt.parts.push({ index: 1, provider: 'Gemini', text: 'part one summary' });
  checkpointMod.saveCheckpoint(ckpt);
  const reloaded = checkpointMod.loadCheckpoint('BBBBBBBBBBB');
  assert.strictEqual(reloaded.parts.length, 1);
  assert.strictEqual(reloaded.parts[0].text, 'part one summary');
});

test('initCheckpoint starts fresh when the transcript hash changes (no mixing settings)', () => {
  const plan = { isChunked: false, chunks: [] };
  const first = checkpointMod.initCheckpoint({ videoId: 'CCCCCCCCCCC', transcript: 'transcript A', summaryLevel: 'legacy', plan });
  first.finalResult = { text: 'final for A', provider: 'ChatGPT' };
  checkpointMod.saveCheckpoint(first);
  const second = checkpointMod.initCheckpoint({ videoId: 'CCCCCCCCCCC', transcript: 'a completely different transcript B', summaryLevel: 'legacy', plan });
  assert.strictEqual(second.finalResult, null);
});

test('initCheckpoint resumes the same checkpoint when transcript+level are unchanged', () => {
  const plan = { isChunked: false, chunks: [] };
  const first = checkpointMod.initCheckpoint({ videoId: 'DDDDDDDDDDD', transcript: 'stable transcript', summaryLevel: 'reg', plan });
  first.parts.push({ index: 1, provider: 'Claude', text: 'stable part' });
  checkpointMod.saveCheckpoint(first);
  const second = checkpointMod.initCheckpoint({ videoId: 'DDDDDDDDDDD', transcript: 'stable transcript', summaryLevel: 'reg', plan });
  assert.strictEqual(second.parts.length, 1);
});

test('clearCheckpoint removes both the checkpoint and transcript cache', () => {
  const plan = { isChunked: false, chunks: [] };
  checkpointMod.initCheckpoint({ videoId: 'EEEEEEEEEEE', transcript: 'x', summaryLevel: 'legacy', plan });
  checkpointMod.saveTranscriptCache('EEEEEEEEEEE', 'cached transcript text');
  assert.ok(checkpointMod.loadCheckpoint('EEEEEEEEEEE'));
  assert.strictEqual(checkpointMod.loadTranscriptCache('EEEEEEEEEEE'), 'cached transcript text');
  checkpointMod.clearCheckpoint('EEEEEEEEEEE');
  assert.strictEqual(checkpointMod.loadCheckpoint('EEEEEEEEEEE'), null);
  assert.strictEqual(checkpointMod.loadTranscriptCache('EEEEEEEEEEE'), null);
});

test('loadCheckpoint tolerates a corrupt/partial checkpoint file (returns null, no throw)', () => {
  const file = path.join(tmpCheckpointDir, 'FFFFFFFFFFF.json');
  fs.writeFileSync(file, '{ not valid json', 'utf8');
  assert.strictEqual(checkpointMod.loadCheckpoint('FFFFFFFFFFF'), null);
});

// --- rotate.js -----------------------------------------------------------------
const rotate = require('../termux-engine/rotate');

test('rotation order is ChatGPT -> Gemini -> Claude -> wrap', () => {
  assert.deepStrictEqual(rotate.ROTATION_ORDER, ['ChatGPT', 'Gemini', 'Claude']);
  assert.strictEqual(rotate.nextProvider('ChatGPT'), 'Gemini');
  assert.strictEqual(rotate.nextProvider('Gemini'), 'Claude');
  assert.strictEqual(rotate.nextProvider('Claude'), 'ChatGPT');
});

// --- net-guard.js (Tailscale/private-address allowlist for the remote-Linux server.js) ----
const netGuard = require('../termux-engine/net-guard');

test('net-guard allows loopback addresses', () => {
  assert.strictEqual(netGuard.isAllowedAddress('127.0.0.1'), true);
  assert.strictEqual(netGuard.isAllowedAddress('::1'), true);
});

test('net-guard allows classic RFC1918 private ranges (same-LAN parity with the Windows engine)', () => {
  assert.strictEqual(netGuard.isAllowedAddress('192.168.1.42'), true);
  assert.strictEqual(netGuard.isAllowedAddress('10.0.0.5'), true);
  assert.strictEqual(netGuard.isAllowedAddress('172.16.0.1'), true);
  assert.strictEqual(netGuard.isAllowedAddress('172.31.255.255'), true);
  assert.strictEqual(netGuard.isAllowedAddress('172.32.0.1'), false); // just outside 172.16-31
});

test('net-guard allows Tailscale\'s CGNAT range 100.64.0.0/10', () => {
  assert.strictEqual(netGuard.isAllowedAddress('100.64.0.1'), true);
  assert.strictEqual(netGuard.isAllowedAddress('100.100.50.7'), true);
  assert.strictEqual(netGuard.isAllowedAddress('100.127.255.255'), true);
});

test('net-guard rejects a public address and addresses just outside the Tailscale range', () => {
  assert.strictEqual(netGuard.isAllowedAddress('8.8.8.8'), false);
  assert.strictEqual(netGuard.isAllowedAddress('100.63.255.255'), false); // just below 100.64.0.0
  assert.strictEqual(netGuard.isAllowedAddress('100.128.0.0'), false); // just above 100.127.255.255
});

test('net-guard rejects malformed/non-IPv4 input', () => {
  assert.strictEqual(netGuard.isAllowedAddress('not-an-address'), false);
  assert.strictEqual(netGuard.isAllowedAddress('999.999.999.999'), false);
});

// --- launch-chrome.js (pure argument-construction/binary-discovery logic only - no real
// Chrome process or network is ever started by these tests) --------------------------------
const launchChrome = require('../termux-engine/launch-chrome');

test('findChromeBinary resolves the first candidate found via injected `which`', () => {
  const calls = [];
  const resolved = launchChrome.findChromeBinary(undefined, {
    runWhich: (cmd) => { calls.push(cmd); return cmd === 'chromium-browser' ? '/usr/bin/chromium-browser' : null; },
    exists: () => false,
  });
  assert.strictEqual(resolved, '/usr/bin/chromium-browser');
  assert.deepStrictEqual(calls, ['google-chrome-stable', 'google-chrome', 'chromium-browser']);
});

test('findChromeBinary falls back to a direct path candidate when no command resolves', () => {
  const resolved = launchChrome.findChromeBinary(undefined, {
    runWhich: () => null,
    exists: (p) => p === '/opt/google/chrome/chrome',
  });
  assert.strictEqual(resolved, '/opt/google/chrome/chrome');
});

test('findChromeBinary returns null when nothing matches (caller must surface a clear error)', () => {
  const resolved = launchChrome.findChromeBinary(undefined, { runWhich: () => null, exists: () => false });
  assert.strictEqual(resolved, null);
});

test('buildArgs never embeds literal quote characters around --user-data-dir (Linux argv, no shell reparsing)', () => {
  const args = launchChrome.buildArgs({ port: 9333, profileDir: '/home/user/.yt-summary-termux/chrome-profile', headless: true });
  const userDataDirArg = args.find((a) => a.startsWith('--user-data-dir='));
  assert.strictEqual(userDataDirArg, '--user-data-dir=/home/user/.yt-summary-termux/chrome-profile');
  assert.ok(!userDataDirArg.includes('"'));
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--headless=new'));
});

test('buildArgs omits --headless=new when headless is explicitly disabled', () => {
  const args = launchChrome.buildArgs({ port: 9333, profileDir: '/tmp/profile', headless: false });
  assert.ok(!args.includes('--headless=new'));
});

// --- server.js (JobQueue serialization only - no real HTTP listener/network is started) ----
const { JobQueue, tokenMatches } = require('../termux-engine/server');

test('tokenMatches requires an exact, non-empty match', () => {
  assert.strictEqual(tokenMatches('secret123', 'secret123'), true);
  assert.strictEqual(tokenMatches('secret123', 'wrong'), false);
  assert.strictEqual(tokenMatches('secret123', ''), false);
  assert.strictEqual(tokenMatches('', 'secret123'), false);
});

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}`);
    console.error(err.stack || err.message);
  }
}

async function runAsyncTests() {
  await testAsync('JobQueue runs queued jobs one at a time, in order, via the SAME runVideo pipeline function', async () => {
    const started = [];
    const finished = [];
    let resolveA;
    // Fake runner stands in for cli.js's runVideo: proves the queue serializes access
    // (never starts job B before job A finishes) via explicit control, not timing guesses.
    const fakeRunner = (args) => {
      started.push(args.videoId);
      if (args.videoId === 'AAAAAAAAAAA') {
        return new Promise((resolve) => { resolveA = () => { finished.push('AAAAAAAAAAA'); resolve({ outFile: 'a.txt', text: 'ok', provider: 'ChatGPT' }); }; });
      }
      finished.push(args.videoId);
      return Promise.resolve({ outFile: `${args.videoId}.txt`, text: 'ok', provider: 'ChatGPT' });
    };
    const queue = new JobQueue(fakeRunner);
    const jobA = queue.enqueue({ videoId: 'AAAAAAAAAAA' });
    const jobB = queue.enqueue({ videoId: 'BBBBBBBBBBB' });
    await Promise.resolve(); // let enqueue's synchronous _pump() call start job A
    assert.deepStrictEqual(started, ['AAAAAAAAAAA']); // job B must not have started while A was running
    resolveA();
    await new Promise((r) => setTimeout(r, 20)); // let the queue's finally-block pump job B
    assert.deepStrictEqual(started, ['AAAAAAAAAAA', 'BBBBBBBBBBB']);
    assert.deepStrictEqual(finished, ['AAAAAAAAAAA', 'BBBBBBBBBBB']);
    assert.strictEqual(queue.get(jobA.id).state, 'done');
    assert.strictEqual(queue.get(jobB.id).state, 'done');
  });

  await testAsync('JobQueue marks a job "error" (not "done") when the pipeline throws, and keeps processing the rest', async () => {
    const fakeRunner = (args) => args.videoId === 'FAILFAILFAIL'
      ? Promise.reject(new Error('STOPPED (retryable): Chunk part 1 failed on every provider.'))
      : Promise.resolve({ outFile: 'ok.txt', text: 'ok', provider: 'Gemini' });
    const queue = new JobQueue(fakeRunner);
    const failing = queue.enqueue({ videoId: 'FAILFAILFAIL' });
    const okJob = queue.enqueue({ videoId: 'OKOKOKOKOKO' });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(queue.get(failing.id).state, 'error');
    assert.ok(queue.get(failing.id).error.includes('STOPPED'));
    assert.strictEqual(queue.get(okJob.id).state, 'done'); // one video's failure must not block the next
  });
}

runAsyncTests().then(() => {
  // Cleanup
  fs.rmSync(tmpCheckpointDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
});
