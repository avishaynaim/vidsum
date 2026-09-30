'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../kiwi-extension/core.js');

const token = 'a'.repeat(64);

test('extracts supported YouTube watch, short, live, and mobile video IDs', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=AVVM-FyewLg',
    'https://m.youtube.com/watch?v=AVVM-FyewLg&t=4',
    'https://youtu.be/AVVM-FyewLg?si=fixture',
    'https://www.youtube.com/shorts/AVVM-FyewLg',
    'https://www.youtube.com/live/AVVM-FyewLg'
  ]) assert.equal(core.parseVideoId(url), 'AVVM-FyewLg', url);
});

test('rejects non-video, malformed, and lookalike YouTube URLs', () => {
  for (const url of [
    'https://www.youtube.com/', 'https://www.youtube.com/watch?v=short',
    'https://youtube.example/watch?v=AVVM-FyewLg',
    'javascript:alert(1)', 'not a URL'
  ]) assert.equal(core.parseVideoId(url), '', url);
});

test('accepts only HTTP pairing URLs on RFC1918 private IPv4 addresses', () => {
  for (const host of ['10.0.0.2', '172.16.0.2', '172.31.255.254', '192.168.1.20']) {
    assert.deepEqual(core.normalizePairingUrl(`http://${host}:8765/#token=${token}`),
      {baseUrl: `http://${host}:8765`, token});
  }
  for (const value of [
    `https://192.168.1.20:8765/#token=${token}`,
    `http://127.0.0.1:8765/#token=${token}`,
    `http://172.32.0.2:8765/#token=${token}`,
    `http://192.168.1.20:8765/#token=short`,
    `http://example.com:8765/#token=${token}`,
    `http://user@192.168.1.20:8765/#token=${token}`,
    `http://192.168.1.20:8765/setup#token=${token}`,
    `http://192.168.1.20:8765/?source=other#token=${token}`
  ]) assert.equal(core.normalizePairingUrl(value), null, value);
});

test('builds a dashboard launch preserving level, normalized title, and request identity', () => {
  const request = '00000000-0000-4000-8000-000000000001';
  const url = new URL(core.launchUrl({
    baseUrl: 'http://192.168.1.20:8765', token, summaryLevel: 'max'
  }, 'AVVM-FyewLg', ' Fixture title - YouTube ', request));
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.origin, 'http://192.168.1.20:8765');
  assert.equal(fragment.get('token'), token);
  assert.equal(fragment.get('video'), 'AVVM-FyewLg');
  assert.equal(fragment.get('title'), 'Fixture title');
  assert.equal(fragment.get('request'), request);
  assert.equal(fragment.get('level'), 'max');
});

test('falls back to Ultra for an unknown extension summary level', () => {
  const url = core.launchUrl({baseUrl: 'http://10.0.0.2:8765', token, summaryLevel: 'invalid'},
    'AVVM-FyewLg', '', '00000000-0000-4000-8000-000000000002');
  assert.equal(new URLSearchParams(new URL(url).hash.slice(1)).get('level'), 'ultra');
});
