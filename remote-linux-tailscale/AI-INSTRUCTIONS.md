# Instructions for the deployment AI

You are deploying this folder onto an always-on Linux machine that the user's
Android phone reaches through Tailscale. Work only inside this folder except
when installing OS packages or creating the systemd service.

## Required outcome

1. Install **Node.js 22+**, **Tailscale**, and desktop
   **Google Chrome or Chromium**, using the Linux distribution's supported
   package mechanism.
2. Run `./setup.sh` and fix every reported prerequisite.
3. Connect the machine to the user's tailnet with `sudo tailscale up`. This
   step may produce an authentication URL; show it to the user and wait for
   them to authorize the device.
4. Run `tailscale ip -4` and record the `100.64.0.0/10` address.
5. Before headless operation, the user must sign into ChatGPT, Gemini, and
   Claude in the persistent Chrome profile. Do **not** request or handle
   the user's passwords. Start the app with `node start.js --headed
   --loopback-only --token temporary-local-token` in a graphical desktop
   session and ask the user to sign in themselves. Preserve
   `~/.yt-summary-termux/chrome-profile`.
6. Generate a long random token locally, for example:
   `openssl rand -hex 32`. Never paste it into logs or a public chat.
7. Copy `yt-summary.service.example` to a temporary working copy, replacing:
   - `REPLACE_WITH_LINUX_USERNAME`
   - `REPLACE_WITH_ABSOLUTE_FOLDER_PATH`
   - `REPLACE_WITH_LONG_RANDOM_SECRET`
8. Install it as `/etc/systemd/system/yt-summary.service`, then run:
   `sudo systemctl daemon-reload && sudo systemctl enable --now yt-summary`.
9. Restrict access with both:
   - Tailscale ACL/grant so only the user's phone can reach TCP port 8787.
   - The app's token authentication.
   Do not expose port 8787 through the public cloud firewall/router.
10. Verify locally:
    `curl -fsS -H "Authorization: Bearer TOKEN" http://127.0.0.1:8787/health`
11. Verify from the Android phone while Tailscale is connected:
    `http://TAILSCALE_IP:8787/?token=TOKEN`
12. Submit one real YouTube URL through the page and confirm the job reaches
    `done`. If provider DOM automation fails, inspect the live desktop Chrome
    DOM and update only `providers.json`/`send.js`; do not invent a separate
    pipeline.

## Important architecture facts

- `start.js` is the one-command supervisor. It launches Chrome, discovers its
  CDP port, passes that port to `server.js`, and shuts both down together.
- `server.js` serves `index.html` plus authenticated `/run`, `/status`, and
  `/health` endpoints. It processes jobs in a FIFO queue, one at a time.
- `cli.js` exports `runVideo()`, the single production pipeline used by both
  CLI and HTTP server.
- Checkpoints and the persistent browser profile live under
  `~/.yt-summary-termux/`.
- No npm packages are needed; the runtime uses Node.js built-ins only.

## Do not claim success until

- `./setup.sh` passes.
- `node tests/test-bundle.js` passes.
- The systemd service is active.
- The authenticated health endpoint works locally.
- The dashboard opens from the Android phone through Tailscale.
- At least one real video job completes after the user signs into providers.

If a real provider changed its page structure, report the exact provider,
selector failure, and DOM evidence before changing selectors.
