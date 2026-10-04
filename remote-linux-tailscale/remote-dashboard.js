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
  // "Read date" in both sort menus (Active, History); the order logic is in SCRIPT_REPLACEMENTS.
  ['<option value="created">Created date</option>', '<option value="created">Created date</option>\n              <option value="read">Read date</option>'],
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
  // app.js clears the #token / #videos part of the address by setting it to '/', which on
  // /torah or /general made a refresh land on the dashboard picker. Keep the path.
  ["  history.replaceState(null, '', '/');", "  history.replaceState(null, '', location.pathname);"],
  // Bookmarklets made on /torah or /general add their videos to that same dashboard.
  ["  const base = location.origin + '/';", "  const base = location.origin + location.pathname;"],
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
  // Each tile shows the video's thumbnail with its channel's avatar on the corner (thumbs.js).
  ["        element.append(head, meta, message, actions);",
    "        element.append(head, meta, message, actions);\n" +
    "        { const pics = document.createElement('a'); pics.className = 'job-pics'; pics.href = link.href; pics.target = '_blank'; pics.rel = 'noopener noreferrer';\n" +
    "          const thumb = document.createElement('img'); thumb.className = 'job-thumb'; thumb.loading = 'lazy'; thumb.alt = ''; thumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(job.VideoId)}/mqdefault.jpg`;\n" +
    "          const avatar = document.createElement('img'); avatar.className = 'job-avatar'; avatar.loading = 'lazy'; avatar.alt = ''; avatar.onerror = () => { avatar.hidden = true; };\n" +
    "          avatar.src = `/thumb/channel?video=${encodeURIComponent(job.VideoId)}&token=${encodeURIComponent(token || '')}`;\n" +
    "          pics.append(thumb, avatar); element.prepend(pics); }"],
  // A finished video: the level menu that REPLACED its summary is hidden; instead "Summarize
  // again at" makes a new job at another level and keeps both (dashboard-api resummarize).
  ["      row.levelSelect.hidden = job.State !== 'queued' && meta.section !== 'history';",
    "      row.levelSelect.hidden = (job.State !== 'queued' && meta.section !== 'history') || job.State === 'completed';\n" +
    "      if (!row.again) {\n" +
    "        const pick = document.createElement('select'); pick.className = 'job-level-select';\n" +
    "        pick.title = 'Make another summary of this video at a different level; this one stays.';\n" +
    "        row.again = document.createElement('span'); row.again.className = 'again-level';\n" +
    "        row.again.append(pick); row.levelSelect.after(row.again);\n" +
    "        // Choosing a level is the action (a separate button was easy to miss).\n" +
    "        pick.addEventListener('change', async () => {\n" +
    "          const level = pick.value; if (!level) return;\n" +
    "          const current = levels[row.again.dataset.level] ? levels[row.again.dataset.level].label : 'current';\n" +
    "          if (!confirm(`Make a new ${levels[level].label} summary of this video? The ${current} summary stays.`)) { pick.value = ''; return; }\n" +
    "          pick.disabled = true;\n" +
    "          try {\n" +
    "            const made = await request('/api/resummarize', 'POST', { jobId: row.againJobId, summaryLevel: level });\n" +
    "            byId('action-message').textContent = made.alreadyExisted\n" +
    "              ? `This video already has a ${levels[level].label} job; both are in the list.`\n" +
    "              : `Added: the same video at ${levels[level].label}. The ${current} summary stays as it is.`;\n" +
    "            alert(byId('action-message').textContent);\n" +
    "          } catch (error) { alert('Could not add it: ' + error.message); }\n" +
    "          finally { pick.value = ''; pick.disabled = false; }\n" +
    "        });\n" +
    "      }\n" +
    "      row.againJobId = job.Id;\n" +
    "      row.again.hidden = job.State !== 'completed';\n" +
    "      if (!row.again.hidden && row.again.dataset.level !== job.SummaryLevel) {\n" +
    "        row.again.dataset.level = job.SummaryLevel;\n" +
    "        const head = document.createElement('option'); head.value = ''; head.textContent = '＋ Summarize again at…';\n" +
    "        row.again.firstChild.replaceChildren(head, ...Object.keys(levels).filter((k) => k !== job.SummaryLevel).map((k) => {\n" +
    "          const o = document.createElement('option'); o.value = k; o.textContent = levels[k].label; return o; }));\n" +
    "      }"],
  // Read marks (remote-extras.js markRead): a read tile is dimmed and says "✓ Read <date>",
  // with "Mark unread" to undo.
  ["      row.state.textContent = job.State + (job.WatchLater ? ' · Watch later' : '');",
    "      row.state.textContent = job.State + (job.WatchLater ? ' · Watch later' : '');\n" +
    "      if (!row.read) {\n" +
    "        row.read = document.createElement('span'); row.read.className = 'read-badge';\n" +
    "        row.state.before(row.read);\n" +
    "        // A clear button in the tile's own row: Mark as unread / Mark as read.\n" +
    "        row.readToggle = document.createElement('button'); row.readToggle.type = 'button'; row.readToggle.className = 'read-toggle';\n" +
    "        row.readToggle.addEventListener('click', () => window.ytMarkRead && window.ytMarkRead(row.readJobId, !row.readIsRead));\n" +
    "        row.levelSelect.parentNode.prepend(row.readToggle);\n" +
    "      }\n" +
    "      row.readJobId = job.Id; row.readIsRead = !!job.ReadAt;\n" +
    "      row.read.hidden = !job.ReadAt;\n" +
    "      if (job.ReadAt) row.read.textContent = '✓ Read ' + new Date(job.ReadAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });\n" +
    "      row.readToggle.hidden = job.State !== 'completed' && !job.ReadAt;\n" +
    "      row.readToggle.textContent = job.ReadAt ? '↺ Mark as unread' : '✓ Mark as read';\n" +
    "      row.element.classList.toggle('is-read', !!job.ReadAt);"],
  // The tile's class list is rebuilt here on every render, so the read mark must be part of it.
  ["          (hasTranscript ? ' has-saved-transcript' : '');",
    "          (hasTranscript ? ' has-saved-transcript' : '') + (job.ReadAt ? ' is-read' : '');"],
  // "Open summary" opens the summary viewer (auto-scroll, Back closes it, read mark) instead of
  // the plain text box further down the page.
  ["            await openLocalResult(job.Id);",
    "            if (window.ytOpenViewer) window.ytOpenViewer(job.Id); else await openLocalResult(job.Id);"],
  // "Open final summary" / "Open all parts" (links into the AI sites) are rarely used: they move
  // to a small "In the AI site:" row at the bottom of the tile, with the parts list.
  ["        actions.append(result, openAllParts, localResult, retry, attach, clear, stop, pause, watchLater, levelSelect, removeJob, startNow, partsList);",
    "        const aiLinks = document.createElement('div'); aiLinks.className = 'ai-links';\n" +
    "        const aiLabel = document.createElement('span'); aiLabel.className = 'ai-links-label'; aiLabel.textContent = 'In the AI site:';\n" +
    "        aiLinks.append(aiLabel, result, openAllParts, partsList);\n" +
    "        actions.append(localResult, retry, attach, clear, stop, pause, watchLater, levelSelect, removeJob, startNow, aiLinks);"],
  ["        result.textContent = 'Open final summary';", "        result.textContent = 'Final summary ↗';"],
  ["      row.openAllParts.textContent = `Open all parts (${partResultUrls.length})`;",
    "      row.openAllParts.textContent = `All parts (${partResultUrls.length}) ▾`;"],
  // "Read date" sort: most recently read first, then unread videos (newest first).
  ["  const SORT_MODES = ['updated', 'status', 'created', 'title'];", "  const SORT_MODES = ['updated', 'status', 'created', 'read', 'title'];"],
  ["    title: (left, right) => (left.Title || left.VideoId).localeCompare(right.Title || right.VideoId)\n  };",
    "    title: (left, right) => (left.Title || left.VideoId).localeCompare(right.Title || right.VideoId),\n" +
    "    read: (left, right) => (jobSortTime(right.ReadAt) - jobSortTime(left.ReadAt)) ||\n" +
    "      (jobSortTime(right.CreatedAt) - jobSortTime(left.CreatedAt)) || String(left.VideoId).localeCompare(String(right.VideoId))\n  };"],
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
// The Torah / regular dashboards (server.js DASHBOARD_PATHS): same page, its own name, and every
// request it makes says which dashboard it is for (X-Space), so the server shows and adds only
// that dashboard's videos, channels and searches.
const SPACE_NAMES = { torah: { label: 'Torah videos', icon: '📜' }, general: { label: 'Regular videos', icon: '🎓' } };

function spaceScript(space) {
  const other = space === 'torah' ? 'general' : 'torah';
  const me = SPACE_NAMES[space];
  return `<script>(()=>{const S=${JSON.stringify(space)},f=window.fetch.bind(window);` +
    `window.fetch=(input,init={})=>{const u=new URL(typeof input==='string'?input:input.url,location.href);` +
    `if(u.origin===location.origin&&u.pathname.startsWith('/api/')){const h=new Headers(init.headers||(typeof input==='string'?undefined:input.headers));h.set('X-Space',S);init={...init,headers:h}}` +
    `return f(input,init)};` +
    // Saved snapshots, drafts and filters are kept per dashboard; only the access key is shared.
    `for(const m of ['getItem','setItem','removeItem']){const o=Storage.prototype[m];` +
    `Storage.prototype[m]=function(k,...r){return o.call(this,k==='yt-summary-token'?k:S+':'+k,...r)}}` +
    `document.title=${JSON.stringify(`${me.label} · YT Summary`)};` +
    `document.addEventListener('DOMContentLoaded',()=>{const b=document.querySelector('.brand');if(!b)return;` +
    `const t=b.querySelector('b');if(t)t.textContent=${JSON.stringify(`${me.icon} ${me.label}`)};` +
    `const a=document.createElement('a');a.className='space-switch';a.href='/${other}';` +
    `a.textContent=${JSON.stringify(`⇄ ${SPACE_NAMES[other].label}`)};b.append(a)});})();</script>\n`;
}

function buildDashboard({ seedToken = null, space = null } = {}) {
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
  // Browsers only offer crypto.randomUUID on https pages; over Tailscale the page is plain http
  // (http://100.x:8787), where adding a video failed with "crypto.randomUUID is not a function".
  // getRandomValues works on http too, so build the same v4 UUID from it.
  // A link to one summary (…/torah#summary=<job id>, used by Ctrl+click on a tile) is read here,
  // before app.js clears the address; remote-extras.js then opens that summary.
  const summaryLink = "<script>window.__openSummary=((location.hash.match(/(?:^#|&)summary=([0-9a-f-]{36})/i)||[])[1])||null;</script>\n";
  const uuidPolyfill = summaryLink + '<script>if(window.crypto&&!crypto.randomUUID)crypto.randomUUID=()=>' +
    "'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,(c)=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));</script>\n";
  if (!page.text.includes('<head>')) page.missing.push('index.html: <head>');
  page.text = page.text.replace('<head>', `<head>\n${uuidPolyfill}`) // first thing on the page
    .replace('</head>', '<link rel="stylesheet" href="/remote-responsive.css">\n</head>');
  const text = page.text.replace(marker, `${seed}${SPACE_NAMES[space] ? spaceScript(space) : ''}${marker}\n<script src="/remote-extras.js" defer></script>`);
  return { html: text, script: app.text, missing: [...page.missing, ...app.missing] };
}

module.exports = { buildDashboard, HTML_REPLACEMENTS, SCRIPT_REPLACEMENTS, SPACE_NAMES };
