---
category: Feedback
keywords: badge, status, tone, pill, indicator
---

# StatusBadge

Compact inline pill that names a state. `tone` selects the color —
`neutral` | `info` | `success` | `warning` | `danger` — driving the
`accent-*` token chain. Children are the label text. Set `pulse` to animate
the leading dot as a liveliness cue (an "Online" tunnel, a "Live" feed);
it respects `prefers-reduced-motion`.

Non-neutral, non-info tones add a visually-hidden prefix ("Success: ",
"Warning: ", "Error: ") so screen readers convey severity.
