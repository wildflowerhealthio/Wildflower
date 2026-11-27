---
category: Async & Errors
keywords: notice, alert, success, error, callout, message
---

# Notice

An inline callout for a message a caller words itself, whose `tone` says what
happened: `danger` for something that failed (a `role="alert"`), `success` for
something that finished (a `role="status"`). A leading glyph (⚠, ✓) and a
screen-reader-only word ("Error: ", "Success: ") carry the tone besides its
colour. `children` is the message — a sentence or two; the optional
`details` render under it (a list of issues, a disclosure); the optional
`action: { label, onClick }` renders an inline link-text action after it, as
`PartialBanner`'s does. Root props pass through to its `<div>`.
`ErrorBanner` draws its callout through a danger `Notice`, so the two look
and announce the same.
