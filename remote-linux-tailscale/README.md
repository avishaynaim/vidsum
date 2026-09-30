# YT Summary — remote Linux + Tailscale bundle

This folder is self-contained. Copy **this entire folder** to the Linux
machine, then give that machine's AI agent the file
[`AI-INSTRUCTIONS.md`](AI-INSTRUCTIONS.md) and say:

> Follow AI-INSTRUCTIONS.md completely. Install and configure everything,
> stop only when a real summary succeeds from my Android phone over Tailscale.

## What you must do personally

An AI can install and configure almost everything, but it cannot safely do
these identity steps for you:

1. Authorize the Linux machine when `tailscale up` gives an authentication
   link.
2. Sign into ChatGPT, Gemini, and Claude yourself in the Linux machine's
   persistent Chrome profile. Do not give passwords to the deployment AI.
3. Put the generated access token into your Android browser URL:
   `http://TAILSCALE_IP:8787/?token=TOKEN`.

## Manual quick start

```bash
chmod +x setup.sh start.js
./setup.sh
sudo tailscale up
tailscale ip -4

# First run in a Linux graphical desktop so you can sign into providers:
node start.js --headed --loopback-only --token temporary-local-token

# After sign-in, normal headless server:
export YT_SUMMARY_TOKEN="$(openssl rand -hex 32)"
node start.js --port 8787
```

Open this on Android while its Tailscale app is connected:

```text
http://LINUX_TAILSCALE_IP:8787/?token=YOUR_TOKEN
```

Paste a YouTube link into the page and press **Create summary**.

## Security

- Never open TCP 8787 to the public internet.
- Keep it reachable only through Tailscale.
- Use a long random token.
- Restrict the Tailscale ACL/grant to your phone when possible.
- Provider sign-in cookies remain in
  `~/.yt-summary-termux/chrome-profile` on the Linux machine.

## Honest limitation

The offline logic and bundle tests can be verified locally, but real
ChatGPT/Gemini/Claude page automation and a real Tailscale path must be
tested on your Linux machine. Provider websites can change their DOM, so the
deployment AI may need to inspect and update selectors after the first live
run.

## Running it on this box (optional second way — the Windows app is unchanged)

Installed as a **user** service (no sudo), from `yt-summary.user.service.example`:

```bash
systemctl --user status yt-summary        # restart / stop / start the same way
journalctl --user -u yt-summary -f        # logs
cat ~/.config/yt-summary/env              # the access token (keep it private)
```

Open from any browser on a device that has the Tailscale app connected:
`http://100.x.y.z:8787/?token=TOKEN`. After the first visit the token is
remembered in a cookie, so later visits work without it.

**Without Tailscale on the phone:** the same dashboard is also published with
Tailscale Funnel at `https://YOUR-MACHINE.YOUR-TAILNET.ts.net:8443/?token=TOKEN`
(port 443 belongs to another app). Anyone on the internet can reach that
address, so the token is the only lock; keep it secret. Turn it off with
`tailscale funnel --https=8443 off`.

**Sign in to the AI sites (once):** dashboard → *Open sign-in screen*. This
shows the server's own Chrome inside your browser tab (noVNC); log in to
ChatGPT, Gemini and Claude there. Chrome runs headed on a private virtual
screen (Xvfb), never on the real desktop, and the screen is only reachable
through the token-checked `/vnc/` path. Needs `xvfb x11vnc websockify novnc`;
without them the server falls back to headless Chrome and hides the button.

**Change IP:** dashboard → *Change IP now* runs `~/apps/router-ip-rotator`
(override with `ROUTER_ROTATOR_DIR`). The internet — and Tailscale — drops
for about 1–2 minutes; the page reconnects by itself. It is refused while a
summary is running, and queued jobs wait until the IP change finishes.

Finished summaries are also written to `~/yt-summaries/<videoId>.summary.txt`.
