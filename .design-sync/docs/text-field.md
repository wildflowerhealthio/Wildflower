---
category: Forms
keywords: input, text, form, label, description
---

# TextField

Single-line text input bundled with its eyebrow `label` and an optional
`description` helper line — `Field` + `FieldDescription` wrapped over
tundra-css's `input-2`, so every form input on a surface keeps one shape.

Fully controlled (`value` + `onChange(next: string)`). Forwards the usual
input hints: `type`, `inputMode`, `placeholder`, `autoComplete`, `disabled`.
Set `callout` to accent the border when this is the one field the user is
expected to change in context.
