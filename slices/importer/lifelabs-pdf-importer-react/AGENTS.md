# AGENTS.md — slices/importer/lifelabs-pdf-importer-react

The **LifeLabs PDF format's UI** for the importer slice: the
`LifeLabsPdfSettingsPicker` (the report's time zone). Presentation and
interaction only — nothing here decodes a report, recognizes it, or writes
resources. The format has no format-specific `ReviewBody`; the shell's default
per-resource list suffices, so the registry binds `ReviewBody = null`.

## Shape

- `src/settings-picker.tsx` — **`LifeLabsPdfSettingsPicker`** against
  `SettingsPickerProps<LifeLabsPdfSettings>`: a free-text IANA zone field with
  the two LifeLabs provinces' zones (`America/Toronto`, `America/Vancouver`)
  suggested through a `datalist`. Every change is reported up verbatim (the
  shell owns the settings); a name the runtime does not know is flagged inline
  (`aria-invalid`, an alert) with the same `DateTime.zoneMakeNamed` check the
  import's `parse` makes, so the reviewer sees the problem before the import
  fails on it.
- `src/index.ts` — the package barrel: `LifeLabsPdfSettingsPicker`, the
  `SUGGESTED_TIME_ZONES` list and `UNKNOWN_ZONE_MESSAGE` sentence the picker
  renders, and the `SettingsPickerProps` type re-exported from
  `har-importer-react` (the format-agnostic settings-picker contract).

## Layering

Depends on `lifelabs-pdf-importer-core` (the settings type),
`har-importer-react` (`SettingsPickerProps`), `effect`, and `react`. Never
imports `importer-react` or `slices/collector`.

## References

- [lifelabs-pdf-importer-core AGENTS.md](../lifelabs-pdf-importer-core/AGENTS.md)
  — the binding this is the UI for.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  registers this picker and mounts the general per-resource review body for
  this format.
