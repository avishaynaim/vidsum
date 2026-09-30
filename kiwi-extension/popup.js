'use strict';

document.getElementById('summarize').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id) {
    status.textContent = 'No active tab is available.';
    return;
  }
  const result = await chrome.runtime.sendMessage({
    type: 'summarize-tab',
    tabId: tab.id,
    url: tab.url,
    title: tab.title
  });
  status.textContent = result?.ok ? 'Opening YT Summary…' : (result?.error || 'Could not start the summary.');
});
