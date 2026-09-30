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

/**
 * Runs one stage (send `prompt`, get a reply) with full rotation/retry semantics.
 * `checkpoint.rotationCursor` is read for the starting provider and updated in place as
 * rotation proceeds; the caller is responsible for persisting the checkpoint afterward.
 * Returns { text, provider }.
 */
async function runStage(checkpoint, prompt, { onStatus = () => {} } = {}) {
  let provider = checkpoint.rotationCursor || ROTATION_ORDER[0];
  const attempted = new Set();
  const classifications = []; // definite-rejection classifications seen, across all providers

  while (attempted.size < ROTATION_ORDER.length) {
    attempted.add(provider);
    let infraAttempts = 0;
    let ambiguousRetried = false;

    // Inner loop: same-provider retries for transient infra errors / one ambiguous retry.
    // Falls through (breaks) to rotate to the next provider once those are exhausted.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        onStatus(`Sending to ${provider}...`);
        const text = await sendToProvider(provider, prompt);
        checkpoint.rotationCursor = nextProvider(provider);
        return { text, provider };
      } catch (err) {
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
    provider = nextProvider(provider);
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

module.exports = { runStage, nextProvider, ROTATION_ORDER, AllProvidersFailedError };
