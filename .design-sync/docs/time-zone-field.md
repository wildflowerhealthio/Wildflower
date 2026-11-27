---
category: Forms
keywords: time zone, iana, input, datalist, debounce, form
---

# TimeZoneField

A free-text IANA time zone input with its eyebrow `label`, an optional
`description` helper line, and `suggestions` offered through a `datalist`, so
the common zones need no typing and any other zone can still be typed.

What is typed is the field's own draft. `onChange(timeZone)` runs only with a
zone the runtime recognizes, 400ms (`TIME_ZONE_COMMIT_DELAY_MS`) after the last
keystroke, or at once on blur or Enter. An unrecognized name is marked
`aria-invalid` with a danger `Notice` under the input, and the caller keeps the
last zone that was recognized. A zone equal to `value` is not reported. A
`value` changed from outside replaces the draft and drops a pending report; a
report echoing back leaves what has been typed alone.
