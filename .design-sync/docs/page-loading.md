---
category: Async & Errors
keywords: loading, suspense, fallback, spinner
---

# PageLoading

Default `<Suspense fallback>` **body** — a fragment, not a self-wrapping page.
Renders the loading copy into whatever shell its `<Suspense>` boundary already
sits in, matching the `PageBodyError` convention. Override the default
"Loading…" text with `message`.
