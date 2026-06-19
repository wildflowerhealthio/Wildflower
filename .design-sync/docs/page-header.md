---
category: Navigation
keywords: header, title, page, breadcrumb, back
---

# PageHeader

The heading bar at the top of a surface. Renders exactly one per screen as the
first child of the shell — never stack two. `title` accepts text or JSX (an
inline `Chip` for a maturity tag, for example). Optional `subtitle` carries a
record detail (a URL or id); `actions` holds trailing toolbar controls.

`backHref` + `backLabel` add a back affordance via a router `<Link>` — wire
those at the app level inside a router context.
