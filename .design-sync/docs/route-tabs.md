---
category: Navigation
keywords: tabs, tab strip, route, navigation, search param, container query
---

# RouteTabs

A route-linked tab strip above the caller's panel. Each tab is a router
`<Link>` that sets the current route's `tab` search param, with `replace`, so
a tab can be linked to and Back leaves the page. Pass `current` (from the
route's `validateSearch`), `tabs` (`{ id, label }[]`), an `aria-label` naming
the `<nav>`, and the open tab's panel as `children`. Wire it inside a router
context.

From 560px of its own width it is a pill track above the panel; below that it
becomes the top edge of a card holding the panel, scrolling sideways when the
tabs don't fit. The current tab is a raised neutral chip, not the accent.

For a one-of-N choice that isn't navigation (a range preset), use
`SegmentedToggle`.
