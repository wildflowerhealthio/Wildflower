---
category: Async & Errors
keywords: partial data, warning, banner, incomplete, loading
---

# PartialBanner

An amber banner with a breathing dot and one line of copy, for a body
rendered from an incomplete data set that is (or could be) still filling in.
`children` is the copy — a sentence or two. The optional
`action: { label, onClick }` renders an inline link-text action after the copy
(Retry, Load the rest). Shares the `--color-warning-*` tokens with the
warning `StatusBadge`.
