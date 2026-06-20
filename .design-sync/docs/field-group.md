---
category: Forms
keywords: group, fieldset, checkboxes, radios
---

# FieldGroup

Labels a **set** of related controls (a cluster of checkboxes, a set of
toggles) with a group heading. Renders `role="group"` rather than a single
`<label>`, since it names many controls at once. A `FieldDescription` as the
first child supplies help text for the whole group.

`RadioGroup` already renders its own named `<fieldset>`, so it does not need
an outer `FieldGroup`.
