---
category: Navigation
keywords: list, rows, navigation, settings
---

# ItemList

A titled list of rows, each with a `title`, optional `subtitle`, an optional
trailing `actions` slot (often a `Menu`), and an optional `badge`. Rows
activate via `onClick` or an `href`; an `href` starting with `/` renders a
router `<Link>` (wire that inside a router context), other hrefs render a plain
`<a>`.

Use for settings indexes and resource lists where each row drills into a
detail surface.
