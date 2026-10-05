---
category: Async & Errors
keywords: error, alert, banner, mutation error, callout
---

# ErrorBanner

Inline danger-toned `role="alert"` callout for an action that failed while its
screen stays usable — the mutation counterpart to `PageBodyError`. Pass the
nullable `error` straight through (`mutation.error`): it renders nothing for
`null`/`undefined`, so mount it unconditionally. An `Error` with a `cause` (or
tagged/structured fields) adds a collapsible "Show details". A recognised
error shape can render its own surface via the `renderError` prop or the
ambient `ErrorBodyRendererContext`.
