'use strict';
// remote-linux-tailscale/display.js
//
// A private virtual screen for the server's Chrome, viewable from any phone/desktop browser
// through the dashboard's "Sign in" link. Three localhost-only processes:
//
//   Xvfb :N            - the virtual screen Chrome draws on (headed Chrome, not --headless,
//                        so provider sites see a normal browser)
//   x11vnc             - serves that screen over VNC on 127.0.0.1 only, no password; the only
//                        way in is server.js's token-checked /vnc/ proxy
//   websockify + noVNC - turns VNC into a plain web page, again on 127.0.0.1 only
//
// Nothing here is reachable from the network directly; server.js is the single boundary.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const { findFreePort } = require('./launch-chrome');

const NOVNC_WEB_DIRS = ['/usr/share/novnc', '/usr/share/webapps/novnc', '/opt/novnc'];
const SCREEN = { width: 1280, height: 900 };

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findNoVncDir(exists = fs.existsSync) {
  return NOVNC_WEB_DIRS.find((dir) => exists(`${dir}/vnc.html`)) || null;
}

// Lists what is missing for the virtual display; empty array means it can run.
function missingTools(deps = {}) {
  const find = deps.which || which;
  const missing = ['Xvfb', 'x11vnc', 'websockify'].filter((cmd) => !find(cmd));
  if (!(deps.findNoVncDir || findNoVncDir)()) missing.push('novnc');
  return missing;
}

// First display number with no X lock file and no socket, starting well above the real
// desktop's :0/:1 so we never collide with a logged-in session.
function findFreeDisplay(start = 90, exists = fs.existsSync) {
  for (let n = start; n < start + 100; n++) {
    if (!exists(`/tmp/.X${n}-lock`) && !exists(`/tmp/.X11-unix/X${n}`)) return n;
  }
  throw new Error('No free X display number found.');
}

function waitFor(check, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await check()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`${what} did not start within ${timeoutMs}ms`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

// Environment for anything drawing on / reading from the virtual screen. A systemd user
// service inherits WAYLAND_DISPLAY/XDG_SESSION_TYPE=wayland from the desktop session, which
// makes x11vnc refuse to start and lets Chrome pick Wayland (the real desktop) over Xvfb.
function displayEnv(display, base = process.env) {
  const env = { ...base, DISPLAY: display, XDG_SESSION_TYPE: 'x11' };
  delete env.WAYLAND_DISPLAY;
  return env;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function startVirtualDisplay() {
  const missing = missingTools();
  if (missing.length) {
    throw new Error(`Virtual display needs: ${missing.join(', ')} (apt install xvfb x11vnc websockify novnc).`);
  }
  const display = findFreeDisplay();
  const vncPort = await findFreePort();
  const webPort = await findFreePort();
  const procs = [];
  const env = displayEnv(`:${display}`);
  const launch = (cmd, args) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', env });
    proc.once('error', () => {});
    procs.push(proc);
    return proc;
  };
  const stop = () => {
    for (const proc of procs.reverse()) if (proc.exitCode === null && !proc.killed) proc.kill('SIGTERM');
  };

  try {
    launch('Xvfb', [`:${display}`, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp']);
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${display}`), 'Xvfb');

  } catch (err) {
    stop();
    throw err;
  }

  // The sign-in screen (x11vnc + websockify) is only for logging in to the AI sites; right after
  // a boot x11vnc can take longer than usual, and once it did not come up in 10 s and the whole
  // service stayed down. Wait longer, and if it still fails, run without the sign-in screen.
  let screenPort = webPort;
  try {
    launch('x11vnc', ['-display', `:${display}`, '-localhost', '-rfbport', String(vncPort),
      '-nopw', '-forever', '-shared', '-quiet', '-noxdamage']);
    await waitFor(() => portOpen(vncPort), 'x11vnc', 30000);
    launch('websockify', ['--web', findNoVncDir(), `127.0.0.1:${webPort}`, `127.0.0.1:${vncPort}`]);
    await waitFor(() => portOpen(webPort), 'websockify', 30000);
  } catch (err) {
    console.error(`Sign-in screen unavailable (${err.message}); continuing without it.`);
    screenPort = null;
  }

  return { display: `:${display}`, webPort: screenPort, procs, stop, screen: SCREEN };
}

module.exports = { startVirtualDisplay, displayEnv, missingTools, findFreeDisplay, findNoVncDir, SCREEN };
