# AGENTS.md — slices/importer/lifelabs-pdf-importer-react

The **LifeLabs PDF format's UI** for the importer slice: the
`LifeLabsPdfSettingsPicker` (the report's time zone and health card
province), mounted by the shell in its per-format settings form — a change
re-decodes the batch's LifeLabs files under the new settings. Presentation and interaction only — nothing here decodes
a report, recognizes it, or writes resources. The format has no review UI of
its own; the shell's generalized sectioned review (per-report sections,
per-resource include/edit) covers it.

## Shape

- `src/settings-picker.tsx` — **`LifeLabsPdfSettingsPicker`** against
  `SettingsPickerProps<LifeLabsPdfSettings>`: `react-tundraish`'s
  `TimeZoneField` with the two LifeLabs provinces' zones (`America/Toronto`,
  `America/Vancouver`) suggested. The field keeps what is typed as its own
  draft and reports only a zone the runtime recognizes (the
  `isKnownTimeZone` rule the import's `checkTimeZone` applies), 400ms after
  the last keystroke (flushed on blur or Enter): each report re-reads every
  LifeLabs file, and a half-typed zone would make each report unreadable,
  dropping its records from the import plan and the reviewer's choices on
  them. An unrecognized name is flagged inline instead, and the import keeps
  the last zone that was recognized. A zone set from outside while the picker
  is mounted replaces what it shows; its own report echoing back does not.
  Beside it, a `<select>` (tundra's `input-3`, the field's size) of
  `fhir-ca-infoway`'s health card provinces (`HealthCardProvince.all`:
  Ontario, British Columbia and "Other province", labelled by
  `HealthCardProvince.names`), read back through `HealthCardProvince.is` and
  reported as soon as it is picked. The picker is a fragment of the two
  fields, so the container it is placed in spaces them.
- `src/index.ts` — the package barrel: `LifeLabsPdfSettingsPicker` and the
  `SUGGESTED_TIME_ZONES` list it offers.

## Layering

Depends on `lifelabs-pdf-importer-core` (the settings type), `fhir-ca-infoway`
(`HealthCardProvince`), `importer-fundamentals` (`SettingsPickerProps`),
`react-tundraish` (`TimeZoneField`, `Field`), and `react`. Never
imports `importer-react` or a sibling format's UI package.

## References

- [lifelabs-pdf-importer-core AGENTS.md](../../../slices/importer/lifelabs-pdf-importer-core/AGENTS.md)
  — the binding this is the UI for.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  registers this picker and mounts the general per-resource review body for
  this format.
