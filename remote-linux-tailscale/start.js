#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { launchChrome } = require('./launch-chrome');

function parseArgs(argv) {
  const result = {
    apiPort: 8787,
    bindAll: true,
    headless: true,
    token: process.env.YT_SUMMARY_TOKEN || '',
    chromeBinary: process.env.CHROME_BINARY || '',
    profileDir: process.env.YT_CHROME_PROFILE || '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') result.apiPort = Number(argv[++i]);
    else if (argv[i] === '--token') result.token = argv[++i];
    else if (argv[i] === '--loopback-only') result.bindAll = false;
    else if (argv[i] === '--headed') result.headless = false;
    else if (argv[i] === '--chrome') result.chromeBinary = argv[++i];
    else if (argv[i] === '--profile') result.profileDir = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return result;
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
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

  const chromeOptions = { headless: args.headless };
  if (args.chromeBinary) chromeOptions.binary = args.chromeBinary;
  if (args.profileDir) chromeOptions.profileDir = path.resolve(args.profileDir);

  console.log(`Starting desktop Chrome/Chromium (${args.headless ? 'headless' : 'headed'})...`);
  const chrome = await launchChrome(chromeOptions);
  console.log(`Chrome CDP ready on 127.0.0.1:${chrome.port} (${chrome.binary}).`);

  const serverArgs = ['server.js', '--port', String(args.apiPort), '--token', args.token];
  if (args.bindAll) serverArgs.push('--bind-all');
  const server = spawn(process.execPath, serverArgs, {
    cwd: __dirname,
    env: {
      ...process.env,
      CDP_HOST: '127.0.0.1',
      CDP_PORT: String(chrome.port),
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
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  server.on('exit', (code, signal) => {
    if (!chrome.proc.killed) chrome.proc.kill('SIGTERM');
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
