---
category: Forms
keywords: radio, single-select, fieldset, form
---

# RadioGroup

Single-select group of radio options rendered as a native `<fieldset>` with a
`legend`. Controlled via `value` + `onChange`; `name` groups the inputs.
`options` is an array of `{ value, label }` (labels accept JSX); individual
options may be `disabled`.

Needs no outer `Field`/`FieldGroup` — the fieldset+legend already labels the
set.
