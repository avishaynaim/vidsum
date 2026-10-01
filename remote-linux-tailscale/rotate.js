'use strict';
// Orchestrates provider rotation for one stage (one chunk-part or one merge step):
//   - Starts from the persisted rotation cursor (proactive rotation: every stage advances
//     to the next provider even without failure, per the rotation-order requirement).
//   - A definite rejection (usage/size/unavailable) immediately tries the next provider,
//     with no cooldown delay.
//   - A transient infrastructure error (failed tab, missing session, WebSocket plumbing)
//     is retried on the SAME provider up to 3 times with a short bounded backoff, since
//     these are not content rejections and do not warrant abandoning that provider.
//   - An ambiguous post-send service state gets one bounded same-provider retry; if still
//     ambiguous, the engine rotates to the next provider rather than blocking indefinitely
//     (duplicate risk accepted, mirroring the Windows engine's "ambiguous send automatically
//     resent" behavior instead of a manual acknowledgement gate).
// The cursor is persisted after every stage so a restart resumes rotation correctly instead
// of re-trying the same exhausted provider first.

const { sendToProvider, DefiniteRejectionError, AmbiguousServiceError } = require('./send');
const { isTransientInfrastructureError } = require('./cdp');

const ROTATION_ORDER = require('./providers.json').rotationOrder;

function nextProvider(name) {
  const idx = ROTATION_ORDER.indexOf(name);
  if (idx < 0) return ROTATION_ORDER[0];
  return ROTATION_ORDER[(idx + 1) % ROTATION_ORDER.length];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Thrown when the user stops/pauses the video (AbortSignal). Never rotated or retried.
class StoppedError extends Error {
  constructor() {
    super('Stopped at your request.');
    this.stopped = true;
  }
}

function throwIfStopped(signal) {
  if (signal && signal.aborted) throw new StoppedError();
}

/**
 * Runs one stage (send `prompt`, get a reply) with full rotation/retry semantics.
 * `checkpoint.rotationCursor` is read for the starting provider and updated in place as
 * rotation proceeds; the caller is responsible for persisting the checkpoint afterward.
 * Returns { text, provider, url }.
 */
// One generation at a time per provider, shared by every video running in parallel (the
// Windows engine's per-provider gates). A stage takes the first FREE provider in its
// preferred order, so three videos keep ChatGPT, Gemini and Claude busy at the same time.
class ProviderPool {
  constructor() {
    this.busy = new Set();
    this.waiters = [];
  }

  isBusy(name) {
    return this.busy.has(name);
  }

  // Resolves with a free provider from `order` that is not in `exclude`, waiting while every
  // candidate is busy; resolves null when every candidate is excluded.
  acquire(order, exclude, signal) {
    return new Promise((resolve, reject) => {
      const take = () => {
        const candidates = order.filter((p) => !exclude.has(p));
        if (!candidates.length) { resolve(null); return true; }
        const free = candidates.find((p) => !this.busy.has(p));
        if (!free) return false;
        this.busy.add(free);
        resolve(free);
        return true;
      };
      if (take()) return;
      const waiter = { take };
      this.waiters.push(waiter);
      if (signal) {
        signal.addEventListener('abort', () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new StoppedError());
        }, { once: true });
      }
    });
  }

  release(name) {
    this.busy.delete(name);
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) if (!waiter.take()) this.waiters.push(waiter);
  }
}

const defaultPool = new ProviderPool();

async function runStage(checkpoint, prompt, { onStatus = () => {}, signal = null, providers = null, pool = defaultPool } = {}) {
  // `providers` = the dashboard's enabled providers (in rotation order); default all three.
  const order = providers && providers.length ? ROTATION_ORDER.filter((p) => providers.includes(p)) : ROTATION_ORDER;
  const next = (name) => {
    const idx = order.indexOf(name);
    return idx < 0 ? order[0] : order[(idx + 1) % order.length];
  };
  // Preferred order starts at the saved rotation cursor; a busy provider is skipped for a free one.
  const first = order.includes(checkpoint.rotationCursor) ? checkpoint.rotationCursor : next(checkpoint.rotationCursor);
  const preferred = order.map((_, i) => order[(order.indexOf(first) + i) % order.length]);
  const attempted = new Set();
  const classifications = []; // definite-rejection classifications seen, across all providers

  while (attempted.size < order.length) {
    throwIfStopped(signal);
    if (preferred.filter((p) => !attempted.has(p)).every((p) => pool.isBusy(p))) {
      onStatus('Waiting for a free AI site (all are busy with other videos)...');
    }
    const provider = await pool.acquire(preferred, attempted, signal);
    if (!provider) break;
    attempted.add(provider);
    try {
      let infraAttempts = 0;
      let ambiguousRetried = false;

      // Inner loop: same-provider retries for transient infra errors / one ambiguous retry.
      // Falls through (breaks) to rotate to another provider once those are exhausted.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          throwIfStopped(signal);
          onStatus(`Sending to ${provider}...`);
          const reply = await sendToProvider(provider, prompt, { signal });
          checkpoint.rotationCursor = next(provider);
          // { text, url } from send.js; a plain string is accepted too.
          return typeof reply === 'string' ? { text: reply, provider, url: null } : { text: reply.text, provider, url: reply.url || null };
        } catch (err) {
          if (err instanceof StoppedError || (signal && signal.aborted)) throw new StoppedError();
          if (err instanceof DefiniteRejectionError) {
            classifications.push(err.classification);
            onStatus(`${provider}: definite ${err.classification} rejection - rotating immediately (no cooldown).`);
            break; // rotate now, no delay
          }
          if (err instanceof AmbiguousServiceError) {
            if (!ambiguousRetried) {
              ambiguousRetried = true;
              onStatus(`${provider}: ambiguous post-send state (${err.message}); resending once before rotating.`);
              continue;
            }
            onStatus(`${provider}: still ambiguous after one resend; rotating to next provider (duplicate risk accepted).`);
            break;
          }
          if (isTransientInfrastructureError(err)) {
            infraAttempts++;
            if (infraAttempts < 3) {
              const backoffMs = 500 * infraAttempts;
              onStatus(`${provider}: transient infrastructure error (${err.message}); retrying in ${backoffMs}ms (attempt ${infraAttempts + 1}/3).`);
              await sleep(backoffMs);
              continue;
            }
            onStatus(`${provider}: transient infrastructure error persisted after 3 attempts; rotating.`);
            break;
          }
          // Unclassified error: do not silently retry forever; treat as a single-shot
          // failure for this provider and rotate, surfacing the message to the caller/log.
          onStatus(`${provider}: unexpected error (${err.message}); rotating.`);
          break;
        }
      }
    } finally {
      pool.release(provider);
    }
  }

  throw new AllProvidersFailedError(classifications);
}

class AllProvidersFailedError extends Error {
  constructor(classifications) {
    super('All providers rejected or failed this stage; nothing was produced. Progress is preserved in the checkpoint for retry.');
    this.classifications = classifications;
    // True only when every definite rejection observed was a 'size' rejection (and at
    // least one was observed) - the signal used to decide whether an adaptive re-chunk
    // (smaller parts) is likely to help, versus a plain retryable stop.
    this.allSize = classifications.length > 0 && classifications.every((c) => c === 'size');
  }
}

module.exports = { runStage, nextProvider, ROTATION_ORDER, AllProvidersFailedError, StoppedError, ProviderPool, defaultPool };
