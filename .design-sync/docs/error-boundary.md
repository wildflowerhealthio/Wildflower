---
category: Async & Errors
keywords: error, boundary, crash, fallback, recover
---

# ErrorBoundary

Catch-all React error boundary. Renders a summary line plus collapsed
`<details>` panes for the error stack, component stack, and a context blob,
with buttons to copy the debug JSON or reload. `title` and `headingLevel`
style the heading; `onError` forwards to telemetry; `extraContext` merges
app-specific build/flag info into the context pane.
