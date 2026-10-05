---
category: Navigation
keywords: segmented control, tabs, view switcher, toggle, pill
---

# SegmentedToggle

A pill-shaped one-of-N view switcher: a `role="group"` of `aria-pressed`
buttons with the pressed one painted in the accent. Controlled — pass `value`,
`options` (`{ value, label }[]`), `onChange`, and a required `aria-label`
naming the group ("View", "Range"). Typically sits in a page header row beside
the title. Keep labels short; 2–5 options.
