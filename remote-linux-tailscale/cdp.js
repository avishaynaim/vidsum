'use strict';
// Minimal Chrome DevTools Protocol (CDP) client over the HTTP+WebSocket endpoints exposed
// by `adb forward tcp:<port> localabstract:chrome_devtools_remote` (see README.md). Requires
// Node's built-in global `fetch` and `WebSocket` (Node 22+; Node 18-21 need --experimental
// or the `ws`/`node-fetch` packages substituted here).

const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = process.env.CDP_PORT || '9222';

async function listTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`);
  return res.json();
}

async function newTab(url) {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Target.createTarget failed: CDP /json/new HTTP ${res.status}`);
  return res.json();
}

async function closeTab(targetId) {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/close/${targetId}`);
  return res.ok;
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('internal WebSocket error: connect timed out')); }
    }, 10000);
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('internal WebSocket error: connection failed'));
    }, { once: true });
  });
}

function sendCommand(ws, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`internal WebSocket error: ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression, awaitPromise = true) {
  const result = await sendCommand(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate threw');
  }
  return result.result ? result.result.value : undefined;
}

// Classifies errors from this module (and CDP command failures generally) as transient
// infrastructure problems worth a short bounded retry, per the same categories the Windows
// engine treats as infra-retryable: failed tab creation, missing session, WebSocket
// plumbing errors. Deliberately narrow - provider content rejections must NOT match this
// and must instead go through rejections.js/rotation, never an infra retry loop.
function isTransientInfrastructureError(err) {
  const message = String(err && err.message || err || '');
  return /Target\.createTarget failed|failed to open new tab|Session with given id not found|internal WebSocket error/i.test(message);
}

module.exports = {
  listTargets, newTab, closeTab, connect, sendCommand, evaluate, isTransientInfrastructureError,
};
