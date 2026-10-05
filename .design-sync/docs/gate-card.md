---
category: Async & Errors
keywords: loading, gate, spinner, empty state, loader card
---

# GateCard

A centered loader card for a body that cannot render until something finishes
loading: spinner ring, short `title`, optional `body` explanation, and an
optional link-text `action: { label, onClick }` (an escape hatch or a retry).
`showSpinner={false}` is the paused variant — the same card explaining why the
body is empty when nothing is running. It is a `role="status"` region.
Prefer `PageLoading` for a plain whole-page wait with no explanation.
