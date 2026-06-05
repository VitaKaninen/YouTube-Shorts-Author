// ==UserScript==
// @name         YouTube Shorts Author Labels
// @namespace    https://github.com/VitaKaninen
// @version      1.2.2
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

  // Hover brightening needs a real :hover rule (inline styles can't do :hover).
  const style = document.createElement('style');
  style.textContent =
    '.um-short-author{margin-left:4px;white-space:nowrap;text-decoration:none;' +
    'color:inherit;cursor:pointer;transition:color .1s}' +
    '.um-short-author:hover{color:var(--yt-spec-text-primary,#fff)}';
  document.head.appendChild(style);

  const MAX_CONCURRENT = 5; // simultaneous oembed requests; raise/lower to taste

  // --- concurrency-limited gate ---
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

  // --- author lookup via YouTube oembed (returns author_name + author_url, no API key) ---
  const cache = new Map();    // vid -> { name, url } | null
  const inflight = new Map(); // vid -> Promise<{name,url}|null>

  function getAuthor(vid) {
    if (cache.has(vid)) return Promise.resolve(cache.get(vid));
    if (inflight.has(vid)) return inflight.get(vid);

    const p = (async () => {
      await acquire();
      try {
        return await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://www.youtube.com/oembed?format=json&url=' +
                 encodeURIComponent('https://www.youtube.com/watch?v=' + vid),
            onload: (r) => {
              try {
                const j = JSON.parse(r.responseText);
                resolve(j.author_name ? { name: j.author_name, url: j.author_url || null } : null);
              } catch (e) { resolve(null); }
            },
            onerror: () => resolve(null),   // embedding disabled / network error -> no label
            ontimeout: () => resolve(null),
            timeout: 8000,
          });
        });
      } finally {
        release();
      }
    })().then((info) => {
      cache.set(vid, info);
      inflight.delete(vid);
      return info;
    });

    inflight.set(vid, p);
    return p;
  }

  // --- DOM helpers ---

  // Find the leaf element whose text is the view count (number + "views").
  // Matched by text, not class names, so it survives YouTube's layout churn.
  // NOTE: assumes an English UI. Change "views" below for other locales.
  function findViewsEl(container) {
    const els = container.querySelectorAll('*');
    for (const e of els) {
      if (e.childElementCount === 0 && !e.classList.contains('um-short-author')) {
        const t = e.textContent.trim();
        if (t.length < 40 && /\d.*\bviews\b/i.test(t)) return e;
      }
    }
    return null;
  }

  // Climb from a Short's anchor to the smallest container that also holds the view count.
  function lockupFor(anchor) {
    let n = anchor;
    while (n && n !== document.body) {
      if (findViewsEl(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  // Get or create the label, anchored to the view-count element so it can't duplicate.
  function ensureLabel(viewsEl) {
    const next = viewsEl.nextElementSibling;
    if (next && next.classList.contains('um-short-author')) return next;

    const a = document.createElement('a');
    a.className = 'um-short-author';
    // Channel click should not also trigger the Short's own link.
    a.addEventListener('click', (e) => e.stopPropagation());
    viewsEl.insertAdjacentElement('afterend', a);
    return a;
  }

  async function labelShort(viewsEl, vid) {
    const a = ensureLabel(viewsEl);

    // DOM nodes can be reused for a different Short; refresh only when the video changes.
    if (a.dataset.vid === vid && a.textContent) return; // already labeled for this video
    a.dataset.vid = vid;
    a.textContent = '';
    a.removeAttribute('href');

    const info = await getAuthor(vid);
    if (a.dataset.vid !== vid) return; // reassigned mid-fetch
    if (info) {
      a.textContent = ' \u00B7 ' + info.name; // " · Channel Name"
      if (info.url) a.href = info.url;
    } else {
      a.textContent = '';
    }
  }

  // --- scan the page; dedupe by the view-count element (one Short has several /shorts/ links) ---
  function scan() {
    const seen = new Set();
    document.querySelectorAll('a[href*="/shorts/"]').forEach((anchor) => {
      const m = anchor.href.match(/\/shorts\/([\w-]+)/);
      if (!m) return;
      const lockup = lockupFor(anchor);
      if (!lockup) return;
      const viewsEl = findViewsEl(lockup);
      if (!viewsEl || seen.has(viewsEl)) return;
      seen.add(viewsEl);
      labelShort(viewsEl, m[1]);
    });
  }

  // --- run on load, on later DOM changes, and after SPA navigation ---
  let debounce = null;
  const rescan = () => { clearTimeout(debounce); debounce = setTimeout(scan, 300); };

  new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', rescan);
  scan();
})();
