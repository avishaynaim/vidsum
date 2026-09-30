YT Summary for Kiwi (Android)
================================

1. On Windows, start the helper with:
     Start YT Summary.cmd -EnableKiwi
   If address detection is ambiguous:
     Start YT Summary.cmd -EnableKiwi -KiwiAddress 192.168.1.20

2. Keep the PC and Android device on the same private Wi-Fi/LAN. If Windows asks,
   allow the helper on Private networks only. Never expose its port on a router.

3. Copy the complete "Pairing URL" printed by the Windows helper.

4. In Kiwi, open Extensions, enable Developer mode, choose Load unpacked, and
   select this kiwi-extension folder after copying it to Android.

5. Open the extension's Details > Extension options, paste the pairing URL,
   choose a summary level, and save.

6. Share a YouTube video to Kiwi. A freshly shared video is handed to the
   Windows helper and the full dashboard opens in that Kiwi tab. The extension
   toolbar button is the manual fallback.

Security
--------
The pairing URL contains the helper's 256-bit authorization secret. Keep it
private. Mobile access accepts only the selected RFC1918 private IPv4 address,
preserves same-origin JSON checks, and is disabled unless -EnableKiwi is used.
Traffic is local HTTP because the helper has no publicly trusted certificate;
do not use public, guest, or untrusted Wi-Fi.
