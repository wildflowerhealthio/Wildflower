---
category: Navigation
keywords: tabs, tab strip, route, child routes, navigation, outlet
---

# RouteTabs

A tab strip over the router's child routes. Each tab is a router `<Link>` to
a child route of the page's route, with `replace`, so a tab can be linked to
and Back leaves the page. Render it as (or in) the page route's component and
pass `tabs` (each a link's options plus a `label`) and an `aria-label` naming
the `<nav>`; the open child route fills the panel under the strip through the
`<Outlet />` it renders. The router marks the open tab; the page's index route
redirects to the first tab. Wire it inside a router context.

From a 768px viewport it is a pill track above the panel; below that it
becomes the top edge of a card holding the panel, scrolling sideways when the
tabs don't fit. `wideFromOwnWidth` switches on the component's own width
instead. The current tab is a raised neutral chip, not the accent.

For a one-of-N choice that isn't navigation (a range preset), use
`SegmentedToggle`.
