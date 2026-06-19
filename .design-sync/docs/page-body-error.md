---
category: Async & Errors
keywords: error, body, message, retry
---

# PageBodyError

A drop-in error **body** — a fragment, not a page. Renders no container of its
own; slot it into a page shell that already supplies the page `h1`. The
optional `title` is an `h2` sub-heading; `error` is rendered as its `.message`
(multi-line messages keep their structure in a monospace `<pre>`). An optional
`retry` adds a Retry button.
