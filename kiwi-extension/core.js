'use strict';

const YtSummaryKiwi = (() => {
  const levels = new Set(['ultra', 'max', 'reg', 'min', 'micro', 'full']);

  function parseVideoId(value) {
    try {
      const url = new URL(value);
      let id = '';
      if (url.hostname === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
      else if (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) {
        id = url.searchParams.get('v') ||
          /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(url.pathname)?.[1] || '';
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
    } catch {
      return '';
    }
  }

  function normalizePairingUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      const token = new URLSearchParams(url.hash.slice(1)).get('token') || '';
      if (url.protocol !== 'http:' || !/^[a-f0-9]{64}$/.test(token) ||
          url.username || url.password || url.pathname !== '/' || url.search ||
          !/^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/.test(url.hostname)) {
        return null;
      }
      return {baseUrl: url.origin, token};
    } catch {
      return null;
    }
  }

  function launchUrl(settings, videoId, title, requestId) {
    const level = levels.has(settings.summaryLevel) ? settings.summaryLevel : 'ultra';
    const params = new URLSearchParams({
      token: settings.token,
      video: videoId,
      title: String(title || '').trim().replace(/\s+-\s+YouTube$/i, '').trim().slice(0, 300),
      request: requestId,
      level
    });
    return `${settings.baseUrl}/#${params}`;
  }

  return {parseVideoId, normalizePairingUrl, launchUrl};
})();

if (typeof module !== 'undefined') module.exports = YtSummaryKiwi;
