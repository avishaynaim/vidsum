'use strict';
// Fills a provider's composer, clicks Send, and polls the DOM for a reply or an error
// banner - the mobile-Chrome-via-CDP equivalent of Send-YtComposer/Wait-YtAssistantReply
// in YtSummary.psm1. Definite rejections (usage/size/unavailable, per rejections.js) throw
// a tagged error so the caller (rotate.js) can rotate immediately with no cooldown; ambiguous
// 'service' text is surfaced separately so the caller can decide (bounded retry) instead of
// silently treating it as either success or definite failure.

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp');
const { classifyFailure, isDefiniteRejection } = require('./rejections');

const providers = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8')).providers;

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

function trySelectors(selectors, action) {
  const list = JSON.stringify(selectors);
  return `(() => {
    const selectors = ${list};
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { ${action} return true; }
    }
    return false;
  })()`;
}

async function findOrOpenTab(cfg) {
  const targets = await cdp.listTargets();
  const host = new URL(cfg.url).host;
  let target = targets.find((t) => t.type === 'page' && t.url && t.url.includes(host));
  if (!target) target = await cdp.newTab(cfg.url);
  return target;
}

async function fillAndSend(ws, cfg, prompt) {
  const promptJson = JSON.stringify(prompt);
  const filled = await cdp.evaluate(ws, trySelectors(cfg.editorSelectors, `
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      el.value = ${promptJson};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = ${promptJson};
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  `));
  if (!filled) throw new AmbiguousServiceError('composer not found (selectors may need updating for this provider/mobile layout)');
  await new Promise((r) => setTimeout(r, 400));
  const clicked = await cdp.evaluate(ws, trySelectors(cfg.sendSelectors, 'el.click();'));
  if (!clicked) throw new AmbiguousServiceError('send control not found');
}

async function pollForReply(ws, cfg, { timeoutMs = 120000, pollMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErrorText = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const text = await cdp.evaluate(ws, `(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(cfg.assistantMessageSelector)});
      const last = nodes[nodes.length - 1];
      return last ? last.innerText : null;
    })()`);
    const errorText = await cdp.evaluate(ws, `(() => {
      const el = document.querySelector(${JSON.stringify(cfg.errorSelector)});
      return el ? el.innerText : null;
    })()`);
    if (errorText) {
      const classification = classifyFailure(errorText, true);
      if (isDefiniteRejection(classification)) throw new DefiniteRejectionError(classification, errorText);
      lastErrorText = errorText;
    }
    if (text && text.trim().length > 0) {
      const classification = classifyFailure(text, false);
      if (isDefiniteRejection(classification)) throw new DefiniteRejectionError(classification, text);
      return text.trim();
    }
  }
  throw new AmbiguousServiceError(
    lastErrorText
      ? `timed out waiting for a reply; last observed non-definite banner: ${lastErrorText}`
      : 'timed out waiting for a reply (bound composer/response wait exceeded)'
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
    if (!target.url || !target.url.includes(new URL(cfg.url).host)) {
      await cdp.sendCommand(ws, 'Page.navigate', { url: cfg.url });
      await new Promise((r) => setTimeout(r, 3000));
    }
    await fillAndSend(ws, cfg, prompt);
    return await pollForReply(ws, cfg, options);
  } finally {
    ws.close();
  }
}

module.exports = { sendToProvider, DefiniteRejectionError, AmbiguousServiceError };
