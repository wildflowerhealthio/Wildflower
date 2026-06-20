---
category: Forms
keywords: switch, toggle, on-off, setting
---

# ToggleSwitch

Pill-style on/off switch over a native `<input type="checkbox" role="switch">`,
so it inherits keyboard handling and assistive-tech semantics. Controlled via
`checked` + `onChange(checked: boolean)`, with a `label` rendered beside the
track (clicking the label flips it).

Reserve the switch for "takes effect now" toggles; for save-on-submit forms a
`Checkbox` reads more naturally. A `disabled` switch may omit `onChange`.
