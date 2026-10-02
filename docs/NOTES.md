# YouTube Shorts Author — design notes

Shorts lockups carry no channel name, so each Short's author comes from
`/oembed?url=…watch?v=<id>` (no API key) and is shown as a link after the view count.

## Constraints that prevent regressions

- **`lockupFor` must stop at the card boundary** (`hasOtherShort`): the first ancestor holding a
  link to a *different* Short is outside this card. Without it, a card whose view count is not yet
  rendered (or doesn't match) climbs to the shelf `div#contents` and grabs another card's count →
  name missing on one card and shown under the wrong Short on another. Timing-dependent; showed up
  in LibreWolf. Reproduce by blanking a card's view-count text.
- **View-count regex is anchored to the whole text** (`7.4K views`, `1,234 views`, `1 view`,
  `No views`). An unanchored `\d.*views` missed `1 view`/`No views` (which then hit the bug above)
  and could match a title. English UI only.
- **Only 429/5xx/network/timeout are retried** (after `RETRY_MS`, via a scheduled rescan). Other
  non-200s (401 = embedding disabled, 404) are final → cached `null`, no label. Caching every
  failure as `null` made one slow load lose names until a page reload.
- **Rescans are throttled, not debounced**: continuous DOM churn (hover previews) would reset a
  debounce forever.
- **YouTube Watched Indicator** makes the subhead a `display:flex` row and prepends its badge.
  Hence `ensureLabel`: view count `flex-shrink:0; white-space:nowrap` (else it wraps beside a long
  name), row `align-items:flex-start` (keeps count + badge at the top) and `flex-wrap:wrap` (a long
  name drops to its own line instead of a 1-char column). The name span wraps; the `·` doesn't, so
  wrapped lines hang-indent.
- **Existing label is found via `row > .um-short-author`, never moved back next to the count**:
  moving it would ping-pong with any other script that also inserts right after the count.
- Label starts `display:none` (no lone `·`); its click `stopPropagation()`s so the Short's own link
  handler doesn't also fire.
