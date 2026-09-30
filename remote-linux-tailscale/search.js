'use strict';
// remote-linux-tailscale/search.js
//
// Full-text search over saved summaries. A match is shown with CONTEXT_WORDS words before and
// after it; matches whose context windows touch are merged into one passage, which then runs
// until CONTEXT_WORDS words after the last of them. Matching ignores letter case and Hebrew
// vowel/cantillation marks (niqqud), and treats any run of whitespace as one space, while all
// offsets refer to the original text so the viewer can highlight the exact characters.

const DEFAULT_CONTEXT_WORDS = 30;
const MAX_PASSAGES_PER_SECTION = 50;

// Hebrew points and cantillation (U+0591-U+05C7) except punctuation that separates words:
// maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun hafukha U+05C6.
const IGNORED = /[֑-ׇֽֿׁׂׅׄ]/;

// { norm, map }: map[i] is the original index of norm[i].
function normalizeWithMap(text) {
  let norm = '';
  const map = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (IGNORED.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      norm += ' ';
      map.push(i);
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

function normalizeQuery(query) {
  return normalizeWithMap(String(query || '')).norm.trim();
}

// All [start, end) ranges in the ORIGINAL text where the (normalized) query occurs.
function findMatches(text, query) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const { norm, map } = normalizeWithMap(text);
  const ranges = [];
  let from = 0;
  for (;;) {
    const at = norm.indexOf(q, from);
    if (at < 0) break;
    ranges.push([map[at], map[at + q.length - 1] + 1]);
    from = at + q.length;
  }
  return ranges;
}

// Words of the text with their offsets: [{ start, end }].
function wordOffsets(text) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) words.push({ start: m.index, end: m.index + m[0].length });
  return words;
}

// Index of the word containing (or first after) character offset `pos`.
function wordIndexAt(words, pos) {
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end <= pos) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Passages around the matches: [{ text, start, highlights: [[s, e] relative to text],
// rangeIndexes: [i...], clippedBefore, clippedAfter }].
function buildPassages(text, ranges, contextWords = DEFAULT_CONTEXT_WORDS) {
  if (!ranges.length) return [];
  const words = wordOffsets(text);
  if (!words.length) return [];
  const windows = [];
  ranges.forEach(([start, end], index) => {
    const first = Math.max(0, wordIndexAt(words, start) - contextWords);
    const last = Math.min(words.length - 1, wordIndexAt(words, end - 1) + contextWords);
    const prev = windows[windows.length - 1];
    // Touching or overlapping windows become one passage that runs past the later match.
    if (prev && first <= prev.last + 1) {
      prev.last = Math.max(prev.last, last);
      prev.rangeIndexes.push(index);
    } else {
      windows.push({ first, last, rangeIndexes: [index] });
    }
  });
  return windows.slice(0, MAX_PASSAGES_PER_SECTION).map((w) => {
    const start = words[w.first].start;
    const end = words[w.last].end;
    return {
      text: text.slice(start, end),
      start,
      highlights: w.rangeIndexes.map((i) => [ranges[i][0] - start, ranges[i][1] - start]),
      rangeIndexes: w.rangeIndexes,
      clippedBefore: w.first > 0,
      clippedAfter: w.last < words.length - 1,
    };
  });
}

// Searches one video's sections ([{ key, label, provider, text }]).
function searchSections(sections, query, contextWords) {
  const results = [];
  for (const section of sections) {
    const ranges = findMatches(section.text || '', query);
    if (!ranges.length) continue;
    results.push({
      key: section.key, label: section.label, provider: section.provider || '',
      ranges, passages: buildPassages(section.text, ranges, contextWords),
    });
  }
  return results;
}

module.exports = {
  normalizeWithMap, normalizeQuery, findMatches, buildPassages, searchSections, DEFAULT_CONTEXT_WORDS,
};
