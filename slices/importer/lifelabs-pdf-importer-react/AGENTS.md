# AGENTS.md — slices/importer/lifelabs-pdf-importer-react

The **LifeLabs PDF format's UI** for the importer slice: the
`LifeLabsPdfSettingsPicker` (the report's time zone) and the `ReviewBody` the
shell mounts inside its preview. Presentation and interaction only — nothing
here decodes a report, recognizes it, or writes resources.

## Shape

- `src/settings-picker.tsx` — **`LifeLabsPdfSettingsPicker`** against
  `SettingsPickerProps<LifeLabsPdfSettings>`: a free-text IANA zone field with
  the two LifeLabs provinces' zones (`America/Toronto`, `America/Vancouver`)
  suggested through a `datalist`. Every change is reported up verbatim (the
  shell owns the settings); a name the runtime does not know is flagged inline
  (`aria-invalid`, an alert) with the same `DateTime.zoneMakeNamed` check the
  import's `parse` makes, so the reviewer sees the problem before the import
  fails on it.
- `src/index.ts` — re-exports **`ReviewBody`** from `har-importer-react`. The
  review is a view over `importer-fundamentals`' format-agnostic `Review`
  model, grouping a file's responses by URL — for this format, the one URL the
  decode mints per file — with the same per-resource include toggles and inline
  editor; there is nothing LifeLabs-specific to add, and the How-To asks for the
  HAR review's shape to be reused rather than re-derived.

## Layering

Depends on `lifelabs-pdf-importer-core` (the settings type),
`har-importer-react` (`SettingsPickerProps`, `ReviewBody`), `effect`, and
`react`. Never imports `importer-react` or `slices/collector`.

## References

- [lifelabs-pdf-importer-core AGENTS.md](../lifelabs-pdf-importer-core/AGENTS.md)
  — the binding this is the UI for.
- [har-importer-react AGENTS.md](../har-importer-react/AGENTS.md) — the
  review this package re-exports.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  registers both parts.
