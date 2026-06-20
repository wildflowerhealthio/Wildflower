---
category: Async & Errors
keywords: suspense, promise, async, await, loading
---

# Awaited

Suspends on a `promise` and renders its resolved value via a `children`
render-prop, with a built-in error boundary. `resetKey` clears a displayed
error when it changes (a refresh counter, a path-param string) — omitting it
defaults to a constant, so the error never self-resets. Either supply your own
`errorComponent` or let it fall back to the styled default error body.
