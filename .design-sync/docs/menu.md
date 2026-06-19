---
category: Navigation
keywords: menu, dropdown, actions, overflow, kebab
---

# Menu

Overflow ("…") trigger that opens a dropdown of actions. `label` is the
accessible name (not shown). `items` is an array of `{ id, label, onSelect }`;
mark dangerous actions with `destructive: true` (red), and inert ones with
`disabled: true`. `align="start"` opens the list flush to the trigger's start
edge.

Commonly lives in an `ItemList` row's `actions` slot or a toolbar.
