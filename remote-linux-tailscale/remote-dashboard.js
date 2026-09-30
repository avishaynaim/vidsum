'use strict';
// remote-linux-tailscale/remote-dashboard.js
//
// Serves the Windows helper's own dashboard (../index.html + ../app.js) for the remote
// server, so both look and behave the same. The files on disk are never modified; a short,
// explicit list of wording changes is applied as they are served, only where the Windows text
// would be wrong remotely (e.g. "local only", "Start YT Summary.cmd", "Stop helper and close
// its browser"). tests/test-bundle.js asserts every replacement still matches, so a change to
// the Windows files fails loudly instead of silently showing Windows wording.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const HTML_REPLACEMENTS = [
  ['<span>local only</span>', '<span>remote server</span>'],
  ['Connecting to your local helper...', 'Connecting to the server...'],
  ['<li>Sign into the provider websites in the separate Chrome window.</li>',
    '<li>Sign into the provider websites once with <b>Open sign-in screen</b> (Remote server panel): it shows the server\'s own browser.</li>'],
  ['<p>Up to four videos run at once, one in-flight generation per provider, 2s between starts. Each video keeps its own tab.</p>',
    '<p>One video runs at a time in the server\'s browser; the others wait in the queue. Each part starts in a fresh chat.</p>'],
  ['If a login or Cloudflare check appears, complete it in that browser window.',
    'If a login or Cloudflare check appears, complete it through the sign-in screen.'],
  ['<p>Keep the bookmark private: it holds a local authorization token. Transcripts stay in memory except Full results you requested. Job metadata, links and the browser profile are stored locally only.</p>',
    '<p>Keep the bookmarks and your dashboard link private: they hold the server\'s access key. Summaries, job history and the browser profile are stored on the server only.</p>'],
  ['<button id="stop">Stop helper and close its browser</button>', '<button id="stop">Stop all work</button>'],
  ['<div class="panel-title">Full transcript result</div>', '<div class="panel-title">Summary</div>'],
  ['<button id="copy-full-result" class="primary">Copy full transcript</button>', '<button id="copy-full-result" class="primary">Copy summary</button>'],
  ['aria-label="Complete structured transcript"', 'aria-label="Summary" dir="auto"'],
  ['#full-result-text { min-height: 220px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }',
    // 4x the original 320px, and grows to the whole text instead of scrolling inside a box.
    '#full-result-text { min-height: 1280px; field-sizing: content; font-size: 14px; line-height: 1.6; unicode-bidi: plaintext; text-align: start; }'],
];

const SCRIPT_REPLACEMENTS = [
  ["'Handing this video to the local controller...'", "'Handing this video to the server...'"],
  ["localResult.textContent = 'Open full transcript';", "localResult.textContent = 'Open summary';"],
  ["'Unable to open the full transcript: '", "'Unable to open the summary: '"],
  ["'Full transcript copied.'", "'Summary copied.'"],
  ["'Clipboard permission was unavailable. Press Ctrl+C to copy the selected transcript.'",
    "'Clipboard permission was unavailable. Press Ctrl+C to copy the selected summary.'"],
  ["'Showing the last known jobs and history. The helper is not running, so active work is no longer progressing and actions are disabled until restart.'",
    "'Showing the last known jobs and history. The server is unreachable right now (for example during an IP change); this page reconnects by itself.'"],
  ["'Open Start YT Summary.cmd to resume the controller. '", "'Waiting for the server to answer again. '"],
  ["'Stop active workers and close the dedicated browser? Unstarted jobs stay queued for the next launch. Your regular browser stays open.'",
    "'Stop all work? The running video stops after its current step and keeps its progress. Queued videos wait until you start them again.'"],
  ["'The helper was stopped from this dashboard. The last known jobs and history remain visible.'",
    "'All work was stopped from this dashboard. Reload the page to see the queue and start it again.'"],
  ["status('Stopped', 'Start the launcher again when you need the bookmark.');",
    "status('Stopped', 'All work stopped. Reload this page and use Start queued videos to continue.');"],
  ["'Showing the saved status snapshot while reconnecting to the local helper.'",
    "'Showing the saved status snapshot while reconnecting to the server.'"],
  ["'Showing the last known jobs and history. Running work cannot continue while the helper is offline; its final state is reconciled after restart.'",
    "'Showing the last known jobs and history. The server is unreachable right now; running work resumes from its checkpoint and this page reconnects by itself.'"],
  ["'Open the Start YT Summary launcher to get an authorized setup page.'", "'Open your dashboard link again and enter the access key.'"],
  ["'Queued videos will reopen the dedicated browser automatically. Interrupted sends are not replayed.'",
    "'Queued videos wait until the server browser answers again. Interrupted sends are not replayed.'"],
  ["'Start the videos that were still queued when the helper restarted?'", "'Start the videos that were still queued when work stopped or the server restarted?'"],
  ["' It starts once the dedicated browser is available again.'", "' It starts once the server browser is available again.'"],
  ["'The helper is stopped; start it before adding videos.'", "'All work is stopped; reload the page and start the queue before adding videos.'"],
  ["'The dedicated browser will reopen automatically for queued videos. Existing requests are retained.'",
    "'The server browser is not responding; queued videos wait for it. Existing requests are retained.'"],
  ["'Unable to stop the helper: '", "'Unable to stop all work: '"],
  // U+2068/U+2069 isolate the title so a Hebrew title keeps its own direction after "Title:".
  ["? `Title: ${job.Title}`", "? `Title: \u2068${job.Title}\u2069`"],
  // Where the video came from (a channel/playlist import, or added on its own), under its title.
  ["        : `Title: YouTube video ${job.VideoId} · looking up title…`;",
    "        : `Title: YouTube video ${job.VideoId} · looking up title…`;\n" +
    "      if (!row.source) { row.source = document.createElement('a'); row.source.className = 'job-source'; row.source.target = '_blank'; row.source.rel = 'noopener noreferrer'; row.title.after(row.source); }\n" +
    "      row.source.textContent = job.SourceTitle ? `From ${job.SourceKind === 'playlist' ? 'playlist' : 'channel'}: \\u2068${job.SourceTitle}\\u2069` : 'Single video';\n" +
    "      if (job.SourceUrl) row.source.href = job.SourceUrl; else row.source.removeAttribute('href');"],
  // Search also matches the channel/playlist name.
  ["const searchTextOf = job => `${job.Title || ''} ${job.VideoId || ''}`.toLowerCase();",
    "const searchTextOf = job => `${job.Title || ''} ${job.VideoId || ''} ${job.SourceTitle || ''}`.toLowerCase();"],
  // Lets a tap on the tile open its summary viewer (remote-extras.js).
  ["        element.className = 'job-card';", "        element.className = 'job-card';\n        element.dataset.jobId = job.Id;"],
];

function applyReplacements(text, replacements, name) {
  const missing = [];
  for (const [from, to] of replacements) {
    if (!text.includes(from)) { missing.push(from.slice(0, 70)); continue; }
    text = text.split(from).join(to);
  }
  return { text, missing: missing.map((m) => `${name}: ${m}`) };
}

// Builds the page. `seedToken` (only for an already-authorized request) is stored where
// app.js looks for it, so a login through the form or cookie works without a #token= link.
function buildDashboard({ seedToken = null } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const page = applyReplacements(html, HTML_REPLACEMENTS, 'index.html');
  const app = applyReplacements(script, SCRIPT_REPLACEMENTS, 'app.js');
  // Also swaps a short access key in a #token= link for the dashboard key, since app.js reads
  // the link first and only accepts its 64-hex format.
  const seed = seedToken
    ? `<script>try{const k=${JSON.stringify(seedToken)};for(const s of [sessionStorage,localStorage])if(s.getItem('yt-summary-token')!==k)s.setItem('yt-summary-token',k);` +
      `const h=new URLSearchParams(location.hash.slice(1));if(h.has('token')&&h.get('token')!==k){h.set('token',k);history.replaceState(null,'','#'+h)}}catch(e){}</script>\n`
    : '';
  const marker = '<script src="/app.js" defer></script>';
  if (!page.text.includes(marker)) page.missing.push('index.html: app.js script tag');
  if (!page.text.includes('</head>')) page.missing.push('index.html: </head>');
  page.text = page.text.replace('</head>', '<link rel="stylesheet" href="/remote-responsive.css">\n</head>');
  const text = page.text.replace(marker, `${seed}${marker}\n<script src="/remote-extras.js" defer></script>`);
  return { html: text, script: app.text, missing: [...page.missing, ...app.missing] };
}

module.exports = { buildDashboard, HTML_REPLACEMENTS, SCRIPT_REPLACEMENTS };
