'use strict';
// Fills a provider's composer, clicks Send, and waits for the finished reply - the Linux
// equivalent of Send-YtComposer/Wait-YtAssistantReply in YtSummary.psm1, following the same
// rules that made the Windows engine reliable:
//   - every stage starts in a fresh chat, so an older answer can never be read as this one;
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

async function findOrOpenTab(cfg) {
  const targets = await cdp.listTargets();
  const host = new URL(cfg.url).host;
  let target = targets.find((t) => t.type === 'page' && cdp.hostOf(t.url) === host);
  if (!target) target = await cdp.newTab(cfg.url);
  return target;
}

// Page-side snapshot of the conversation, evaluated on every poll.
function stateExpression(cfg) {
  return `(() => {
    const visible = (e) => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
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

async function readState(ws, cfg) {
  return cdp.evaluate(ws, stateExpression(cfg));
}

async function waitFor(check, timeoutMs, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

async function pollForReply(ws, cfg, baseline, { timeoutMs = 600000, pollMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErrorText = '';
  let previous = null;
  let stable = 0;
  let unchanged = 0;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const s = await readState(ws, cfg).catch(() => null); // mid-navigation: just poll again
    if (!s) continue;
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
        return s.lastText;
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
 * Sends `prompt` to `providerName` and returns the assistant's reply text.
 * Throws DefiniteRejectionError for immediate-rotate cases, AmbiguousServiceError for
 * ambiguous post-send state, or a plain Error for a CDP-level problem (which cdp.js's
 * isTransientInfrastructureError() can further classify for bounded infra retry).
 */
async function sendToProvider(providerName, prompt, options = {}) {
  const cfg = providers[providerName];
  if (!cfg) throw new Error(`Unknown provider: ${providerName}`);
  const target = await findOrOpenTab(cfg);
  const ws = await cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.sendCommand(ws, 'Page.enable');
    const baseline = await fillAndSend(ws, cfg, prompt);
    return await pollForReply(ws, cfg, baseline, options);
  } finally {
    ws.close();
  }
}

module.exports = { sendToProvider, DefiniteRejectionError, AmbiguousServiceError };
