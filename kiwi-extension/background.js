'use strict';

importScripts('core.js');

async function summarize(tabId, pageUrl, title) {
  const videoId = YtSummaryKiwi.parseVideoId(pageUrl);
  if (!videoId) return {ok: false, error: 'Open a YouTube video first.'};
  const settings = await chrome.storage.local.get(['baseUrl', 'token', 'summaryLevel']);
  if (!/^http:\/\/.+/.test(settings.baseUrl || '') || !/^[a-f0-9]{64}$/.test(settings.token || '')) {
    await chrome.runtime.openOptionsPage();
    return {ok: false, error: 'Pair the extension with the Windows helper first.'};
  }
  await chrome.tabs.update(tabId, {
    url: YtSummaryKiwi.launchUrl(settings, videoId, title, crypto.randomUUID())
  });
  return {ok: true};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'summarize-shared-video' && sender.tab?.id !== undefined) {
    summarize(sender.tab.id, message.url, message.title).then(sendResponse);
    return true;
  }
  if (message?.type === 'summarize-tab' && Number.isInteger(message.tabId)) {
    summarize(message.tabId, message.url, message.title).then(sendResponse);
    return true;
  }
  if (message?.type === 'parse-pairing-url') {
    sendResponse(YtSummaryKiwi.normalizePairingUrl(message.value));
  }
});
