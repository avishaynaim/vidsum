#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { launchChrome } = require('./launch-chrome');
const display = require('./display');

function parseArgs(argv) {
  const result = {
    apiPort: 8787,
    bindAll: true,
    // 'virtual' = headed Chrome on a private Xvfb screen, viewable from the dashboard's
    // sign-in link; 'current' = headed on $DISPLAY (--headed); 'headless' = no screen.
    // null = virtual when its tools are installed, else headless.
    displayMode: null,
    token: process.env.YT_SUMMARY_TOKEN || '',
    chromeBinary: process.env.CHROME_BINARY || '',
    profileDir: process.env.YT_CHROME_PROFILE || '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') result.apiPort = Number(argv[++i]);
    else if (argv[i] === '--token') result.token = argv[++i];
    else if (argv[i] === '--loopback-only') result.bindAll = false;
    else if (argv[i] === '--headed') result.displayMode = 'current';
    else if (argv[i] === '--headless') result.displayMode = 'headless';
    else if (argv[i] === '--virtual-display') result.displayMode = 'virtual';
    else if (argv[i] === '--chrome') result.chromeBinary = argv[++i];
    else if (argv[i] === '--profile') result.profileDir = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return result;
}

// 20 letters/digits (~119 bits): short enough to paste or type on a phone without getting
// cut off, still far beyond guessing.
function randomToken(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < alphabet.length * 4) out += alphabet[byte % alphabet.length];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.apiPort) || args.apiPort < 1 || args.apiPort > 65535) {
    throw new Error('--port must be an integer from 1 to 65535.');
  }
  if (!args.token) {
    args.token = randomToken();
    console.log(`Generated access token: ${args.token}`);
    console.log('Save this token. Your phone needs it to open the dashboard.');
  }

  let mode = args.displayMode;
  if (!mode) {
    const missing = display.missingTools();
    mode = missing.length ? 'headless' : 'virtual';
    if (missing.length) console.log(`Sign-in screen disabled, missing: ${missing.join(', ')}. Running headless.`);
  }

  let screen = null;
  if (mode === 'virtual') {
    screen = await display.startVirtualDisplay();
    console.log(`Virtual display ${screen.display} ready (sign-in screen via the dashboard).`);
  }

  const chromeOptions = { headless: mode === 'headless' };
  if (screen) {
    chromeOptions.display = screen.display;
    chromeOptions.windowSize = screen.screen;
  }
  if (args.chromeBinary) chromeOptions.binary = args.chromeBinary;
  if (args.profileDir) chromeOptions.profileDir = path.resolve(args.profileDir);

  console.log(`Starting desktop Chrome/Chromium (${mode})...`);
  let chrome;
  try {
    chrome = await launchChrome(chromeOptions);
  } catch (error) {
    if (screen) screen.stop();
    throw error;
  }
  console.log(`Chrome CDP ready on 127.0.0.1:${chrome.port} (${chrome.binary}).`);

  // The token travels by environment, not argv, so other local users cannot read it via ps.
  const serverArgs = ['server.js', '--port', String(args.apiPort)];
  if (args.bindAll) serverArgs.push('--bind-all');
  const server = spawn(process.execPath, serverArgs, {
    cwd: __dirname,
    env: {
      ...process.env,
      YT_SUMMARY_TOKEN: args.token,
      CDP_HOST: '127.0.0.1',
      CDP_PORT: String(chrome.port),
      ...(screen ? { VNC_WEB_PORT: String(screen.webPort) } : {}),
    },
    stdio: 'inherit',
  });

  let stopping = false;
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping (${signal})...`);
    if (!server.killed) server.kill('SIGTERM');
    if (!chrome.proc.killed) chrome.proc.kill('SIGTERM');
    if (screen) screen.stop();
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  server.on('exit', (code, signal) => {
    if (!chrome.proc.killed) chrome.proc.kill('SIGTERM');
    if (screen) screen.stop();
    process.exitCode = code === null ? 1 : code;
    if (!stopping) console.error(`Server exited unexpectedly (${signal || code}).`);
  });
  chrome.proc.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`Chrome exited unexpectedly (${signal || code}).`);
      if (!server.killed) server.kill('SIGTERM');
    }
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, randomToken };
