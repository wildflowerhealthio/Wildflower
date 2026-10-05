---
category: Forms
keywords: checkbox, multi-select, permissions, checklist, group
---

# CheckboxGroup

A multi-select list of checkboxes driven by an `items` array and one
`onToggle(id)` callback — the caller owns the checked state. Each item has an
`id`, `label`, `checked`, `locked`, `disabled`, and optional `mono` (a code or
unit shown in monospace beside the label) and `reason` (tooltip explaining a
lock or disable).

- `locked`: checked and not editable (required or implied) — rendered disabled.
- `disabled`: not applicable here — shown disabled, never hidden.
- `direction`: `column` (default) or `row` for a compact short set.
- `variant`: `boxed` (default, the design-system `Checkbox`) or `plain`, a
  chrome-less checklist for embedding inside a host card.

Give it an `ariaLabel` naming the set ("Permissions on Observation").
