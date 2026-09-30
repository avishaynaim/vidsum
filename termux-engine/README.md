# Termux on-device engine, plus a remote-Linux+Tailscale option (EXPERIMENTAL — largely untested end-to-end)

## Two ways to run this without your Windows PC
This folder actually supports two deployments, sharing the exact same pipeline
(`cli.js`'s `runVideo`, `checkpoint.js`, `rotate.js`, `chunk.js`, `rejections.js`):

- **Option A — on your phone, via Termux + ADB self-pairing** (original design,
  see the setup steps below). Talks to *mobile* Chrome's DOM over an ADB-forwarded
  CDP socket. No extra machine needed, but mobile Chrome's DOM likely differs from
  the desktop DOM the provider selectors (`providers.json`) were written against —
  expect to debug selectors live.
- **Option B — a remote Linux box (a spare machine, a cheap VPS, or a
  Tailscale-networked mini PC) running *real* desktop Chrome/Chromium, reached from
  your phone over Tailscale.** This is the **recommended** option if you have (or
  can get) any small always-on Linux machine: it reuses the exact same
  battle-tested desktop-Chrome DOM the Windows engine's selectors already target —
  no ADB pairing dance, no mobile-DOM differences to debug — and Tailscale gives you
  secure remote access from anywhere, not just your home Wi-Fi (unlike the
  same-LAN-only Kiwi extension).

### Option B: remote Linux box + Tailscale — setup
1. **On the Linux box**: install Node 22+, Tailscale
   (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`), and a
   real browser (`sudo apt install google-chrome-stable` or `chromium`, depending
   on distro/repo availability).
2. **On your phone**: install the official Tailscale Android app and join the same
   tailnet. Note the Linux box's Tailscale IP (`tailscale ip -4` on the box, or the
   Tailscale admin console) — it will be in the `100.64.0.0/10` range.
3. **Start the server** on the Linux box:
   ```
   cd termux-engine
   node server.js --port 8787 --bind-all --token <a-long-random-secret>
   ```
   `--bind-all` is required to accept connections from your phone (default is
   loopback-only, matching the Windows engine's default-safe posture). Every
   request is checked against `net-guard.js` (loopback, RFC1918, or Tailscale's
   `100.64.0.0/10` range only — anything else gets `403`) **and** must present
   `--token`'s secret, since Tailscale's own device auth is the real trust
   boundary, not the address shape alone.
4. **Launch real Chrome with CDP enabled** on the same box, separately (this is
   NOT started automatically by `server.js` yet — see `launch-chrome.js`):
   ```
   node -e "require('./launch-chrome').launchChrome({ headless: true }).then(r => console.log('CDP ready on port', r.port))"
   ```
   then set `CDP_PORT` to the printed port (and `CDP_HOST=127.0.0.1`, the default)
   before/when running jobs, so `cdp.js` connects to it.
5. **From your phone's browser** (over Tailscale, e.g. from Kiwi's address bar or
   any browser), trigger a summary:
   ```
   POST http://<tailscale-ip>:8787/run?token=<secret>
   Body: {"videoId":"dQw4w9WgXcQ","level":"legacy"}
   ```
   Then poll `GET http://<tailscale-ip>:8787/status?jobId=<id>&token=<secret>` for
   progress/result. Jobs run **one at a time** (a simple FIFO queue) — this port
   does not (yet) include the Windows engine's `MaxConcurrent`/per-provider-
   semaphore concurrency; see "What's intentionally NOT ported" below.
6. **Verified here**: `net-guard.js`'s address-allowlist rules (including the
   Tailscale range), `launch-chrome.js`'s pure argument-construction/binary-
   discovery logic, and `server.js`'s `JobQueue` serialization/error-handling —
   all via injected fakes in `tests/test-termux-engine.js`, no real network/Chrome
   needed. **Never run**: the actual Chrome launch, the actual HTTP listener
   against a real client, or anything over a real Tailscale network — there is no
   Linux box, no Tailscale account, and no Chrome/Chromium binary available in the
   sandbox this was built in. Confirm end-to-end on your own box before trusting it.

---

## Option A: Termux on-device engine (EXPERIMENTAL — largely untested end-to-end)

## Status — read this before trusting output
This is a real, fairly complete port of the Windows engine's core pipeline
(transcript fetch, chunking/prompt-building, provider rotation with the same
usage/size/unavailable rejection classification, atomic resumable
checkpoints), **not** a toy demo. However, it was written in a sandbox with
no Android device, no emulator, no network access, and no live
ChatGPT/Gemini/Claude page — so:

- **Verified** (via `node tests/test-termux-engine.js` from the repo root,
  no network/device needed): rejection-phrase classification (including the
  exact "Too many requests" / "You're making requests too quickly" /
  "temporarily limited" phrases), chunk-splitting and prompt construction,
  atomic checkpoint save/load/resume/clear semantics, and rotation-cursor
  math.
- **Never run**: `transcript.js` (fetching YouTube's watch page + caption
  track over the network), `cdp.js`/`send.js` (driving on-device Chrome via
  CDP: filling the composer, clicking Send, reading the reply). These will
  need live debugging on your phone — see "Known likely failure points"
  below.

Do not expect "100% success" out of the box. Getting the Windows engine this
reliable took many iterations of live debugging against real ChatGPT/Gemini
pages; this is starting from zero on a different browser engine/OS with the
same expectation of iteration.

## Why this needs setup at all
Chrome for Android exposes the same DevTools Protocol (CDP) desktop Chrome
does, over an abstract Unix domain socket, reachable only via `adb`. Normally
`adb` runs on a separate PC. The trick used here is **pairing ADB with your
own phone, from Termux, on the same phone** using Android's built-in
"Wireless debugging" feature (Android 11+) — no PC involved.

## One-time setup (on your Android phone)

1. **Enable Wireless debugging**
   Settings → About phone → tap "Build number" 7 times to unlock Developer
   options → Settings → System → Developer options → enable
   "Wireless debugging".

2. **Install Termux packages**
   ```
   pkg update
   pkg install nodejs android-tools
   ```
   Confirm Node is 22+ (needed for the built-in global `fetch`/`WebSocket`
   used throughout this folder): `node -v`. If older, either upgrade the
   `nodejs` package or install `npm install ws node-fetch` and adapt
   `cdp.js`/`transcript.js` accordingly.

3. **Pair Termux's adb client with your phone's own debugging service**
   In Developer options → Wireless debugging, tap "Pair device with pairing
   code". It shows an IP:port and a 6-digit code. In Termux:
   ```
   adb pair <ip>:<pairing-port>
   ```
   Enter the 6-digit code when prompted. Then, from the main Wireless
   debugging screen, note the (different) connect IP:port and run:
   ```
   adb connect <ip>:<connect-port>
   adb devices
   ```
   You should see your own phone listed as a device — this works because
   `adb` is just talking to `adbd` over TCP on `127.0.0.1`/your own Wi-Fi IP.

4. **Forward Chrome's DevTools socket to a local TCP port**
   With Chrome for Android open (any tab) and remote debugging enabled by
   default when wireless debugging is on:
   ```
   adb forward tcp:9222 localabstract:chrome_devtools_remote
   ```
   Verify it works:
   ```
   curl http://127.0.0.1:9222/json
   ```
   You should get back a JSON list of Chrome's open tabs. If this fails,
   Chrome's remote-debugging socket name/availability may differ by Chrome
   version — inspect `adb shell cat /proc/net/unix | grep chrome` to find the
   actual socket name and adjust the `adb forward` target.

## Running the engine

```
cd termux-engine
node cli.js <videoId> --level ultra --first-provider ChatGPT
```

This will:
1. Fetch the video's transcript directly over the network (no browser
   needed for this step — `transcript.js` talks straight to YouTube's watch
   page and caption `timedtext` endpoint).
2. Cache it privately beside a checkpoint under
   `~/.yt-summary-termux/checkpoints/` (mode 600), deleted on completion or
   `--clear`.
3. Build the chunk/prompt plan (same logic and summary-level profiles as
   `TranscriptChunks.psm1`: `ultra`, `max`, `reg`, `min`, `micro`, `full`,
   `legacy`).
4. For each chunk (and the final merge step), rotate ChatGPT → Gemini →
   Claude → wrap, sending via CDP to on-device Chrome, classifying any
   rejection text exactly like `Providers.psm1` does (`usage`/`size`/
   `unavailable` rotate immediately with no cooldown; ambiguous text gets one
   bounded resend before rotating).
5. Persist a checkpoint after every completed part, so re-running the same
   command resumes without redoing finished work.
6. Write the final summary to `<out>/<videoId>.summary.txt` (default `--out`
   is the current directory).

Flags: `--level`, `--first-provider`, `--out <dir>`, `--clear` (wipe this
video's saved progress/transcript cache first), `--max-message-chars N`
(default 22000, same as the Windows engine's default budget).

## Known likely failure points (debug these first, live, on your phone)
- **`providers.json` selectors** were copied verbatim from desktop
  `Providers.psm1`. Mobile Chrome frequently renders a different DOM for the
  same site (different layout, extra wrapper elements, different
  `aria-label` text). If `send.js` reports "composer not found" or "send
  control not found", inspect the live DOM (e.g. temporarily attach a PC via
  `adb forward` + `chrome://inspect` to compare) and update the relevant
  `editorSelectors`/`sendSelectors` arrays.
- **`transcript.js`** assumes YouTube's watch page still embeds
  `ytInitialPlayerResponse` in a `<script>` tag in the shape read here. If it
  throws "not found on watch page", YouTube may have served a consent/sign-in
  interstitial instead (log the raw HTML to check), or changed the markup.
- **CDP endpoint availability** depends entirely on step 4 of setup above
  working; `cdp.js` assumes `127.0.0.1:9222` unless `CDP_HOST`/`CDP_PORT` env
  vars are set.

## What's intentionally NOT ported (versus the full Windows engine)
- Multi-video **concurrent queue** (`MaxConcurrent`, per-provider semaphores).
  This CLI processes one video at a time, sequentially.
- The Windows engine's DOM-based **ambiguous-send reconciliation** (checking
  the conversation for the submitted prompt/hash before deciding to resend).
  This port takes the simpler "one bounded resend, then rotate" approach
  noted in rotate.js instead.
- A **full dashboard UI** — `server.js` (Option B above) adds a minimal
  authenticated JSON status API (`/run`, `/status`, `/health`) so a phone can
  trigger/poll jobs remotely, but there's no browser-based dashboard page (no
  video-tile grid, no batch form) — just raw JSON endpoints for now.
- `server.js` does **not** auto-launch Chrome — you run `launch-chrome.js`
  separately and point `CDP_PORT` at it (see Option B step 4).
- **YouTube's own transcript UI fallback** (the "transcript service" /
  "YouTube's own transcript" dual-source logic in `YtSummary.psm1`). This
  port only reads the caption track directly, which is simpler and doesn't
  need a browser tab, but has no built-in secondary source if it fails.

Porting the rest is a much larger effort — get this core pipeline verified
live and reliable first, then decide whether the fuller feature set is worth
the additional work.

## Honest bottom line
If reliability and "it just works" matters more than avoiding a PC, keep
using the Windows engine when a PC is available. This Termux path trades
PC-dependency for a real, non-trivial engineering/debugging effort on your
own phone with a different browser rendering surface — but it is a legitimate
path to a genuinely PC-free workflow if you're willing to do that debugging.
