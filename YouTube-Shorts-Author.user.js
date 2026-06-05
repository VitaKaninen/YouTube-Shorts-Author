// ==UserScript==
// @name         YouTube Shorts Author Labels
// @namespace    https://github.com/VitaKaninen
// @version      1.0.0
// @description  Show each Short's channel name to the right of its view count, on page load.
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      youtube.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/VitaKaninen/YouTube-Shorts-Author/main/YouTube-Shorts-Author.user.js
// @downloadURL  https://raw.githubusercontent.com/VitaKaninen/YouTube-Shorts-Author/main/YouTube-Shorts-Author.user.js
// ==/UserScript==

(function () {
  'use strict';

  const MAX_CONCURRENT = 4; // simultaneous oembed requests; raise/lower to taste

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

  // --- author lookup via YouTube oembed (returns author_name, no API key needed) ---
  const cache = new Map();    // vid -> author string (or null if unavailable)
  const inflight = new Map(); // vid -> Promise<string|null>

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
              let name = null;
              try { name = JSON.parse(r.responseText).author_name || null; } catch (e) {}
              resolve(name);
            },
            onerror: () => resolve(null),   // embedding disabled / network error -> no label
            ontimeout: () => resolve(null),
            timeout: 8000,
          });
        });
      } finally {
        release();
      }
    })().then((name) => {
      cache.set(vid, name);
      inflight.delete(vid);
      return name;
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
      if (e.childElementCount === 0) {
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

  function getVid(lockup) {
    const a = lockup.querySelector('a[href*="/shorts/"]');
    const m = a && a.href.match(/\/shorts\/([\w-]+)/);
    return m ? m[1] : null;
  }

  function ensureSpan(lockup, viewsEl) {
    let span = lockup._authorSpan;
    if (span && span.isConnected) return span;
    span = document.createElement('span');
    span.className = 'um-short-author';
    span.style.marginLeft = '4px';
    span.style.opacity = '0.9';
    span.style.whiteSpace = 'nowrap';
    viewsEl.insertAdjacentElement('afterend', span); // directly to the right of the count
    lockup._authorSpan = span;
    return span;
  }

  async function processLockup(lockup) {
    const vid = getVid(lockup);
    if (!vid) return;
    const viewsEl = findViewsEl(lockup);
    if (!viewsEl) return;

    const span = ensureSpan(lockup, viewsEl);

    // DOM nodes can be reused for a different Short; refresh only when the video changes.
    if (lockup._authorVid !== vid) {
      span.textContent = '';
      lockup._authorVid = vid;
    } else if (span.textContent) {
      return; // already labeled for this video
    }

    const name = await getAuthor(vid);
    if (getVid(lockup) !== vid) return; // node was reassigned mid-fetch
    span.textContent = name ? ' \u00B7 ' + name : ''; // " · Channel Name"
  }

  // --- scan the whole page; the views-element check filters out nav/other Shorts links ---
  function scan() {
    const seen = new Set();
    document.querySelectorAll('a[href*="/shorts/"]').forEach((a) => {
      const lockup = lockupFor(a);
      if (lockup && !seen.has(lockup)) {
        seen.add(lockup);
        processLockup(lockup);
      }
    });
  }

  // --- run on load, on later DOM changes, and after SPA navigation ---
  let debounce = null;
  const rescan = () => { clearTimeout(debounce); debounce = setTimeout(scan, 300); };

  new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', rescan);
  scan();
})();
