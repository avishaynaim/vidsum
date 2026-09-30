#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer must run on Linux." >&2
  exit 1
fi

echo "Checking required commands..."
missing=()
command -v node >/dev/null || missing+=(nodejs)
command -v tailscale >/dev/null || missing+=(tailscale)
if ! command -v google-chrome-stable >/dev/null &&
   ! command -v google-chrome >/dev/null &&
   ! command -v chromium-browser >/dev/null &&
   ! command -v chromium >/dev/null; then
  missing+=(chrome-or-chromium)
fi

if ((${#missing[@]})); then
  echo "Missing: ${missing[*]}"
  echo "Ask the deployment AI to install Node.js 22+, Tailscale, and desktop Chrome/Chromium"
  echo "using this Linux distribution's official package instructions, then rerun this script."
  exit 2
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if ((node_major < 22)); then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 2
fi

mkdir -p "$HOME/.yt-summary-termux/checkpoints" "$HOME/.yt-summary-termux/chrome-profile"
chmod 700 "$HOME/.yt-summary-termux" "$HOME/.yt-summary-termux/checkpoints" "$HOME/.yt-summary-termux/chrome-profile"

node --check start.js
node --check server.js
node --check launch-chrome.js
node --check cli.js

echo
echo "Local files are ready."
echo "If this device is not connected yet, run: sudo tailscale up"
echo "Then obtain its address with: tailscale ip -4"
echo "Before headless operation, complete provider sign-in once in headed mode:"
echo "  node start.js --headed --loopback-only --token temporary-local-token"
