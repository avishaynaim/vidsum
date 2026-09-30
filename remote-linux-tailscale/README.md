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
