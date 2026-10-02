// ==UserScript==
// @name         YouTube Shorts Author Labels
// @namespace    https://github.com/VitaKaninen
// @version      1.5.0
// @author       VitaKaninen
// @description  Show each Short's channel name (clickable) to the right of its view count, on page load.
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      youtube.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/VitaKaninen/YouTube-Shorts-Author/main/YouTube-Shorts-Author.user.js
// @downloadURL  https://raw.githubusercontent.com/VitaKaninen/YouTube-Shorts-Author/main/YouTube-Shorts-Author.user.js
// ==/UserScript==

(function () {
  'use strict';

  const MAX_CONCURRENT = 5;   // simultaneous oembed requests
  const RETRY_MS = 30000;     // wait before retrying a lookup that failed transiently
  const SCAN_DELAY_MS = 300;  // throttle for DOM-change rescans

  const style = document.createElement('style');
  style.textContent =
    '.um-short-author{margin-left:4px;display:inline-flex;align-items:flex-start;text-decoration:none;' +
    'color:inherit;cursor:pointer;transition:color .1s}' +
    '.um-short-author-sep{flex:0 0 auto;white-space:nowrap;margin-right:.35em}' +
    '.um-short-author-name{min-width:0;white-space:normal;overflow-wrap:anywhere}' +
    '.um-short-author:hover{color:var(--yt-spec-text-primary,#fff)}';
  document.head.appendChild(style);

  // ---- concurrency gate
  let active = 0;
  const waiters = [];
  function acquire() {
    if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
    return new Promise((res) => waiters.push(res));
  }
  function release() {
    active--;
    const next = waiters.shift();
    if (next) { active++; next(); }
  }

  // ---- author lookup via oembed
  const cache = new Map();    // vid -> {name, url} | null (null = definitively no author)
  const inflight = new Map(); // vid -> Promise
  const failedAt = new Map(); // vid -> time of last transient failure

  // One oembed request: {name, url}, null (no author, final), or undefined (transient, retry later).
  function fetchAuthor(vid) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://www.youtube.com/oembed?format=json&url=' +
             encodeURIComponent('https://www.youtube.com/watch?v=' + vid),
        timeout: 8000,
        onload: (r) => {
          if (r.status !== 200) return resolve(r.status >= 500 || r.status === 429 ? undefined : null);
          try {
            const j = JSON.parse(r.responseText);
            resolve(j.author_name ? { name: j.author_name, url: j.author_url || null } : null);
          } catch (e) { resolve(undefined); }
        },
        onerror: () => resolve(undefined),
        ontimeout: () => resolve(undefined),
      });
    });
  }

  // Cached, de-duplicated, rate-limited author lookup; transient failures are retried after RETRY_MS.
  function getAuthor(vid) {
    if (cache.has(vid)) return Promise.resolve(cache.get(vid));
    if (inflight.has(vid)) return inflight.get(vid);
    if (Date.now() - (failedAt.get(vid) || 0) < RETRY_MS) return Promise.resolve(null);

    const p = (async () => {
      await acquire();
      try { return await fetchAuthor(vid); } finally { release(); }
    })().then((info) => {
      inflight.delete(vid);
      if (info === undefined) {
        failedAt.set(vid, Date.now());
        setTimeout(rescan, RETRY_MS + 100);
        return null;
      }
      failedAt.delete(vid);
      cache.set(vid, info);
      return info;
    });
    inflight.set(vid, p);
    return p;
  }

  // ---- DOM helpers

  // The leaf whose whole text is a view count ("7.4K views", "1 view", "No views"). English UI only.
  function findViewsEl(container) {
    for (const e of container.querySelectorAll('*')) {
      if (e.childElementCount === 0 && !e.classList.contains('um-short-author') &&
          /^(?:[\d.,]+\s*[KMB]?|no)\s+views?$/i.test(e.textContent.trim())) return e;
    }
    return null;
  }

  // True when the container holds a link to a Short other than `vid`.
  function hasOtherShort(n, vid) {
    for (const a of n.querySelectorAll('a[href*="/shorts/"]')) {
      const m = a.href.match(/\/shorts\/([\w-]+)/);
      if (m && m[1] !== vid) return true;
    }
    return false;
  }

  // Climb from a Short's anchor to the smallest container that also holds the view count.
  function lockupFor(anchor, vid) {
    let n = anchor;
    while (n && n !== document.body) {
      if (hasOtherShort(n, vid)) return null; // left this Short's card: never borrow a neighbour's count
      if (findViewsEl(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  // Get or create the label right after the view count, styling the row so a long name wraps under it.
  function ensureLabel(viewsEl) {
    viewsEl.style.flexShrink = '0';
    viewsEl.style.whiteSpace = 'nowrap';
    const row = viewsEl.parentElement;
    row.style.alignItems = 'flex-start';
    row.style.flexWrap = 'wrap';

    let a = row.querySelector(':scope > .um-short-author');
    if (a) return a;
    a = document.createElement('a');
    a.className = 'um-short-author';
    const sep = document.createElement('span');
    sep.className = 'um-short-author-sep';
    sep.textContent = '·';
    const name = document.createElement('span');
    name.className = 'um-short-author-name';
    a.append(sep, name);
    a.style.display = 'none';
    a.addEventListener('click', (e) => e.stopPropagation());
    viewsEl.after(a);
    return a;
  }

  // Fill the label for this view count with the Short's channel; refetch only when the video changes.
  async function labelShort(viewsEl, vid) {
    const a = ensureLabel(viewsEl);
    const nameEl = a.querySelector('.um-short-author-name');
    if (a.dataset.vid === vid && nameEl.textContent) return;
    if (a.dataset.vid !== vid) {
      a.dataset.vid = vid;
      nameEl.textContent = '';
      a.style.display = 'none';
      a.removeAttribute('href');
    }

    const info = await getAuthor(vid);
    if (a.dataset.vid !== vid || !info) return; // reassigned mid-fetch, or no author
    nameEl.textContent = info.name;
    a.style.display = '';
    if (info.url) a.href = info.url;
  }

  // Label every Short on the page once (a Short has several /shorts/ links; dedupe by view count).
  function scan() {
    const seen = new Set();
    document.querySelectorAll('a[href*="/shorts/"]').forEach((anchor) => {
      const m = anchor.href.match(/\/shorts\/([\w-]+)/);
      if (!m) return;
      const lockup = lockupFor(anchor, m[1]);
      if (!lockup) return;
      const viewsEl = findViewsEl(lockup);
      if (!viewsEl || seen.has(viewsEl)) return;
      seen.add(viewsEl);
      labelShort(viewsEl, m[1]);
    });
  }

  // ---- triggers: throttled (not debounced) so constant DOM churn can't starve the scan
  let pending = null;
  function rescan() {
    if (!pending) pending = setTimeout(() => { pending = null; scan(); }, SCAN_DELAY_MS);
  }

  new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', rescan);
  scan();
})();
