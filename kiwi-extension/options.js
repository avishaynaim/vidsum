'use strict';

const pairing = document.getElementById('pairing');
const level = document.getElementById('level');
const auto = document.getElementById('auto');
const status = document.getElementById('status');

chrome.storage.local.get(['baseUrl', 'token', 'summaryLevel', 'autoQueueShared']).then(saved => {
  if (saved.baseUrl && saved.token) pairing.value = `${saved.baseUrl}/#token=${saved.token}`;
  level.value = saved.summaryLevel || 'ultra';
  auto.checked = saved.autoQueueShared !== false;
});

document.getElementById('save').addEventListener('click', async () => {
  const parsed = await chrome.runtime.sendMessage({type: 'parse-pairing-url', value: pairing.value});
  if (!parsed) {
    status.textContent = 'Use the complete private-network pairing URL printed by Start-YtSummary.ps1.';
    return;
  }
  await chrome.storage.local.set({
    baseUrl: parsed.baseUrl,
    token: parsed.token,
    summaryLevel: level.value,
    autoQueueShared: auto.checked
  });
  status.textContent = 'Paired. Share a YouTube video to Kiwi, or use the toolbar button on a video.';
});
