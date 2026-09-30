'use strict';
// Ported verbatim (regex-for-regex) from Providers.psm1's Get-YtFailureClassification /
// Test-YtDefiniteRejection / Test-YtBenignBanner / phrase lists, so the on-device engine
// classifies provider rejection text exactly the same way the Windows engine does.
// PowerShell '-imatch' is case-insensitive regex match; JS uses the 'i' flag equivalently.
// PowerShell '.{0,3}' etc. carry over unchanged (both use .NET/JS-compatible regex syntax
// for these simple patterns).

const DEFINITE_USAGE_PHRASES = [
  'too many requests',
  "you.{0,3}re making requests too (?:quickly|fast)",
  'temporarily limited',
  "you.{0,3}ve? (?:hit|reached).{0,40}(?:limit|cap)",
  '(?:usage|message|daily|rate|request).{0,30}(?:limit|cap)',
  'out of (?:messages|credits)',
  'limit resets',
];

const BENIGN_BANNER_PHRASES = [
  'limited access to your conversations',
  'protect your data',
];

const DEFINITE_SIZE_PHRASES = [
  '(?:message|text|prompt|input|context).{0,100}(?:too long|exceed|maximum|length limit)',
  'too many tokens',
  'maximum.{0,40}(?:length|context)',
];

const DEFINITE_UNAVAILABLE_PHRASES = [
  'currently unavailable',
  'service is at capacity',
  'over capacity',
  'no (?:models?|capacity) (?:is |are )?available',
  'a fresh (?:chatgpt|gemini|claude) conversation did not become available',
  '(?:chatgpt|gemini|claude) did not accept the full text or enable send',
  '(?:chatgpt|gemini|claude) accepted the full text but never enabled send',
  'contains an existing draft',
  'is already generating a response',
  'opened an existing conversation',
];

function anyMatch(text, patterns) {
  for (const pattern of patterns) {
    if (new RegExp(pattern, 'i').test(text)) return true;
  }
  return false;
}

function isBenignBanner(text) {
  if (!text || !text.trim()) return false;
  return anyMatch(text, BENIGN_BANNER_PHRASES);
}

/**
 * Classifies free text found on a provider page after a send into:
 *   'usage'       - definite usage/rate/concurrency rejection -> rotate immediately, no cooldown
 *   'size'        - definite size/length rejection -> rotate immediately, no cooldown
 *   'unavailable' - definite service-unavailable rejection -> rotate immediately, no cooldown
 *   'service'     - ambiguous post-send service noise (not necessarily a rejection)
 *   ''            - no classification (healthy)
 * 'usage', 'size' and 'unavailable' are all "definite" failures for rotation purposes.
 */
function classifyFailure(text, explicit = false) {
  if (!text || !text.trim()) return '';
  if (isBenignBanner(text)) return '';
  if (anyMatch(text, DEFINITE_SIZE_PHRASES)) return 'size';
  if (anyMatch(text, DEFINITE_USAGE_PHRASES)) return 'usage';
  if (anyMatch(text, DEFINITE_UNAVAILABLE_PHRASES)) return 'unavailable';
  if (explicit || /something went wrong|error generating|failed to generate|network error/i.test(text)) return 'service';
  return '';
}

function isDefiniteRejection(classification) {
  return classification === 'usage' || classification === 'size' || classification === 'unavailable';
}

module.exports = { classifyFailure, isDefiniteRejection, isBenignBanner };
