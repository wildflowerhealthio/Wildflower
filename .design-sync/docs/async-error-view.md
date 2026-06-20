---
category: Async & Errors
keywords: error, async, catch-boundary, retry
---

# AsyncErrorView

Renders an `error` through `PageBodyError` — an error **body** fragment with
no page container, meant to be slotted into a surrounding shell that supplies
the page `h1`. Designed to drop straight into a TanStack Router
`<CatchBoundary errorComponent>` (the `Awaited` wrapper does exactly that for
the "promise rejected → render error" path). Optional `title` and `retry`
pass through.
