'use strict';
// Fills a provider's composer, clicks Send, and waits for the finished reply - the Linux
// equivalent of Send-YtComposer/Wait-YtAssistantReply in YtSummary.psm1, following the same
// rules that made the Windows engine reliable:
//   - every stage runs in a NEW tab (closed afterwards) with a fresh chat: an older answer can
//     never be read as this one, and a tab that crashed ("Aw, Snap!") is never reused. Reusing
//     one tab per provider all day made them crash after ~60 videos, and every later attempt
//     then timed out on the dead tab;
//   - a crash during a stage is noticed at once (Inspector.targetCrashed) and reported as an
//     infrastructure error, so rotate.js retries it on a fresh tab;
//   - the tab is brought to the front with focus emulation, because Chrome pauses background
//     tabs and the provider then never renders its answer;
//   - text is typed with CDP Input.insertText and Send is clicked with real mouse events
//     (page-side .click()/.textContent are ignored by Gemini's editor and React state);
//   - a reply only counts once the stop button is gone and its text is unchanged across
//     consecutive polls, so a half-streamed answer is never accepted.
// Definite rejections (usage/size/unavailable, per rejections.js) throw a tagged error so
// rotate.js can rotate immediately; ambiguous states throw AmbiguousServiceError.

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp');
const { classifyFailure, isDefiniteRejection } = require('./rejections');

const providers = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8')).providers;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DefiniteRejectionError extends Error {
  constructor(classification, detail) {
    super(`Definite ${classification} rejection: ${detail}`);
    this.classification = classification;
  }
}

class AmbiguousServiceError extends Error {
  constructor(detail) {
    super(`Ambiguous post-send service state: ${detail}`);
  }
}

// Page-side snapshot of the conversation, evaluated on every poll.
function stateExpression(cfg) {
  return `(() => {
    const visible = (e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const href = location.href;
    const editor = ${JSON.stringify(cfg.editorSelectors)}.map((s) => document.querySelector(s)).find(visible) || null;
    const assistants = [...document.querySelectorAll(${JSON.stringify(cfg.assistantMessageSelector)})];
    const last = assistants[assistants.length - 1];
    const answer = last && (last.querySelector(${JSON.stringify(cfg.assistantTextSelector)}) || last);
    const stop = [...document.querySelectorAll(${JSON.stringify((cfg.stopSelectors || []).join(',') || 'x-none')})].some(visible) ||
      [...document.querySelectorAll('button')].some((b) => visible(b) && /stop generating/i.test(b.getAttribute('aria-label') || ''));
    const streaming = !!(last && last.querySelector('[data-is-streaming="true"],[data-streaming="true"]'));
    const error = document.querySelector(${JSON.stringify(cfg.errorSelector)});
    return {
      host: location.host,
      href,
      loaded: document.readyState === 'complete',
      hasEditor: !!editor,
      editorText: editor ? (editor.value !== undefined && editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText).trim().length : 0,
      assistantCount: assistants.length,
      lastText: answer ? answer.innerText.trim() : '',
      busy: stop || streaming,
      errorText: error && visible(error) ? error.innerText.trim() : '',
    };
  })()`;
}

// Focuses the composer and empties any leftover draft, returning false if it is missing.
function focusAndClearExpression(cfg) {
  return `(() => {
    const visible = (e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const el = ${JSON.stringify(cfg.editorSelectors)}.map((s) => document.querySelector(s)).find(visible);
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      el.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('delete');
    return true;
  })()`;
}

function sendButtonExpression(cfg) {
  return `(() => {
    const visible = (e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const button = ${JSON.stringify(cfg.sendSelectors)}.flatMap((s) => [...document.querySelectorAll(s)])
      .find((b) => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!button) return null;
    button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = button.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`;
}

// The canonical conversation link (the same forms the dashboard accepts), or null.
function conversationUrl(href) {
  const m = /^https:\/\/(chatgpt\.com\/c\/[A-Za-z0-9_-]+|gemini\.google\.com\/app\/[A-Za-z0-9_-]+|claude\.ai\/chat\/[A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(href || '');
  return m ? `https://${m[1]}` : null;
}

async function readState(ws, cfg) {
  return cdp.evaluate(ws, stateExpression(cfg));
}

async function waitFor(check, timeoutMs, pollMs = 500, signal = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('Stopped at your request.');
    const value = await check();
    if (value) return value;
    await sleep(pollMs);
  }
  return null;
}

async function keepAwake(ws) {
  for (const [method, params] of [
    ['Page.bringToFront', {}],
    ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ['Page.setWebLifecycleState', { state: 'active' }],
  ]) {
    try { await cdp.sendCommand(ws, method, params, 5000); } catch { /* best effort, as on Windows */ }
  }
}

async function click(ws, point) {
  await cdp.sendCommand(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.sendCommand(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.sendCommand(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

// Opens a fresh chat, types the prompt, clicks Send and confirms the provider accepted it.
// Returns the assistant-message count before sending, so the reply wait only accepts a new one.
async function fillAndSend(ws, cfg, prompt) {
  await cdp.sendCommand(ws, 'Page.navigate', { url: cfg.url });
  await sleep(1500);
  await keepAwake(ws);
  const ready = await waitFor(async () => {
    const s = await readState(ws, cfg).catch(() => null);
    return s && s.host === new URL(cfg.url).host && s.loaded && s.hasEditor ? s : null;
  }, 45000);
  await sleep(1000); // let the single-page app finish wiring the composer
  if (!ready) throw new AmbiguousServiceError('composer not found (not logged in, or the page layout changed)');
  const baseline = ready.assistantCount;

  if (!await cdp.evaluate(ws, focusAndClearExpression(cfg))) throw new AmbiguousServiceError('composer not found');
  await cdp.sendCommand(ws, 'Input.insertText', { text: prompt }, 60000);
  await sleep(800);

  const point = await waitFor(() => cdp.evaluate(ws, sendButtonExpression(cfg)), 15000);
  if (point) await click(ws, point);
  else {
    // No clickable Send control found: fall back to Enter, which all three providers accept.
    await cdp.sendCommand(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.sendCommand(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }

  // Accepted = the composer emptied, or the provider started answering.
  const accepted = await waitFor(async () => {
    const s = await readState(ws, cfg).catch(() => null);
    return s && (s.busy || s.assistantCount > baseline || s.editorText === 0);
  }, 20000);
  if (!accepted) throw new AmbiguousServiceError('the provider did not accept the message (Send had no effect)');
  return baseline;
}

// Marks ws.crashed when Chrome reports that this tab's page crashed.
function watchForCrash(ws) {
  ws.crashed = false;
  ws.addEventListener('message', (event) => {
    try { if (JSON.parse(event.data).method === 'Inspector.targetCrashed') ws.crashed = true; } catch { /* not JSON */ }
  });
}

function throwIfCrashed(ws) {
  if (ws.crashed) throw new Error('internal WebSocket error: the provider tab crashed');
}

async function pollForReply(ws, cfg, baseline, { timeoutMs = 600000, pollMs = 1500, signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErrorText = '';
  let previous = null;
  let stable = 0;
  let unchanged = 0;
  let unreadable = 0;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('Stopped at your request.');
    await sleep(pollMs);
    throwIfCrashed(ws);
    const s = await readState(ws, cfg).catch(() => null); // mid-navigation: just poll again
    if (!s) {
      unreadable++;
      // A page that cannot even evaluate "1" for ~45s is dead, not navigating.
      if (unreadable >= 30) throw new Error('internal WebSocket error: the provider tab stopped responding');
      continue;
    }
    unreadable = 0;
    const hasAnswer = s.assistantCount > baseline && s.lastText && !s.busy;

    if (s.errorText && !hasAnswer) {
      const classification = classifyFailure(s.errorText, true);
      if (isDefiniteRejection(classification)) throw new DefiniteRejectionError(classification, s.errorText);
      lastErrorText = s.errorText;
    }

    if (hasAnswer) {
      if (s.lastText === previous) { stable++; unchanged++; } else { stable = 0; unchanged = 0; previous = s.lastText; }
      if (stable >= 2) {
        const classification = classifyFailure(s.lastText, false);
        if (isDefiniteRejection(classification)) throw new DefiniteRejectionError(classification, s.lastText);
        return { text: s.lastText, url: conversationUrl(s.href) };
      }
    } else {
      stable = 0;
      unchanged++;
    }
    if (unchanged >= 8) {
      await keepAwake(ws); // the answer stopped advancing: wake the tab again
      unchanged = 0;
    }
  }
  throw new AmbiguousServiceError(
    lastErrorText
      ? `timed out waiting for a reply; last observed non-definite banner: ${lastErrorText}`
      : 'timed out waiting for a reply'
  );
}

/**
 * Sends `prompt` to `providerName` and returns { text, url }: the assistant's reply and the
 * conversation's link (null if the provider did not give it a stable address).
 * Throws DefiniteRejectionError for immediate-rotate cases, AmbiguousServiceError for
 * ambiguous post-send state, or a plain Error for a CDP-level problem (which cdp.js's
 * isTransientInfrastructureError() can further classify for bounded infra retry).
 */
async function sendToProvider(providerName, prompt, options = {}) {
  const cfg = providers[providerName];
  if (!cfg) throw new Error(`Unknown provider: ${providerName}`);
  // A new tab for this stage only (see the module comment); closed when the stage ends.
  const target = await cdp.newTab('about:blank');
  let ws;
  try {
    ws = await cdp.connect(target.webSocketDebuggerUrl);
    watchForCrash(ws);
    await cdp.sendCommand(ws, 'Inspector.enable', {}, 10000).catch(() => {});
    await cdp.sendCommand(ws, 'Page.enable', {}, 15000);
    const baseline = await fillAndSend(ws, cfg, prompt);
    throwIfCrashed(ws);
    return await pollForReply(ws, cfg, baseline, options);
  } finally {
    if (ws) ws.close();
    await cdp.closeTab(target.id).catch(() => {});
  }
}

// Opens an existing conversation in a new background tab of the server's browser and returns
// its last finished assistant answer (used by the dashboard's "Attach final summary link").
async function readConversation(url, { timeoutMs = 60000 } = {}) {
  const host = cdp.hostOf(url);
  const name = Object.keys(providers).find((n) => new URL(providers[n].url).host === host);
  if (!name) throw new Error('Unsupported provider conversation link.');
  const cfg = providers[name];
  const target = await cdp.newTab(url);
  const ws = await cdp.connect(target.webSocketDebuggerUrl);
  try {
    await keepAwake(ws);
    let previous = null;
    let stable = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1500);
      const s = await readState(ws, cfg).catch(() => null);
      if (!s || !s.loaded || !s.lastText || s.busy) { stable = 0; continue; }
      if (s.lastText === previous) stable++; else { stable = 0; previous = s.lastText; }
      if (stable >= 2) return s.lastText;
    }
    throw new Error('No finished answer was found in that conversation (is the server browser logged in to it?).');
  } finally {
    ws.close();
    await cdp.closeTab(target.id).catch(() => {});
  }
}

module.exports = { sendToProvider, readConversation, conversationUrl, DefiniteRejectionError, AmbiguousServiceError };
