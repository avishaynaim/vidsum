'use strict';

(async () => {
  const settings = await chrome.storage.local.get(['autoQueueShared']);
  if (settings.autoQueueShared === false) return;

  const source = document.referrer;
  const openedExternally = !source || (() => {
    try { return !new URL(source).hostname.endsWith('youtube.com'); }
    catch { return true; }
  })();
  if (!openedExternally) return;

  const key = `yt-summary-queued:${location.href}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1');
  chrome.runtime.sendMessage({
    type: 'summarize-shared-video',
    url: location.href,
    title: document.title
  });
})();
