'use strict';
// Loads remote-extras.js (browser code) against a tiny fake DOM, so a load-time mistake -
// e.g. using a const before it is declared, which silently removed the Search button and the
// Remote server panel once - fails the tests instead of the live page.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = function testPageScriptLoads() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'remote-extras.js'), 'utf8');
  const node = () => new Proxy(function fake() {}, {
    get: (target, key) => (key === Symbol.toPrimitive ? () => '' : node()),
    set: () => true,
    apply: () => node(),
    construct: () => node(),
  });
  const env = {
    document: node(), window: node(), history: node(), location: node(), sessionStorage: { getItem: () => '' },
    localStorage: { getItem: () => null, setItem() {} }, fetch: () => new Promise(() => {}),
    AbortSignal: { timeout: () => undefined }, ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} }, requestAnimationFrame: () => 0, setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, navigator: {}, confirm: () => false, prompt: () => null,
  };
  assert.doesNotThrow(() => new Function(...Object.keys(env), src)(...Object.values(env)),
    'remote-extras.js must load without errors');
};
