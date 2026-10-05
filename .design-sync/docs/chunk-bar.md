---
category: Async & Errors
keywords: progress, paging, loading bar, pagination, meter
---

# ChunkBar

A page-chunk progress bar for a paged fetch whose total is unknown: one block
per page received (`pagesReceived`), never an "x of y". `phase` is `idle`
(pages arrived by scrolling), `loading` (in-flight block breathes at the
tail), `locked` (everything arrived — blocks merge into one solid bar), or
`error`. Renders nothing under 4 pages; tightens past 24 and wraps every 20.

Hover, focus, or tap opens a tooltip with `loadedCount` and, when `onLoadAll`
is given, a "load all the rest" (idle) or "Retry" (error) action. Override any
copy through `labels` (e.g. `countSuffix: 'medication requests have been
loaded.'`).
