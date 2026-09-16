# AGENTS.md — slices/importer/dicom-importer-react

The **DICOM UI** for the importer slice: the `DicomSettingsPicker`, the one
knob the format has — the IANA time zone the acquiring equipment's clock was
set to. The DICOM format needs no interactive review body; the shell's
generalized sectioned review covers it.

Why a time zone is the knob at all is explained in
[dicom-importer-core AGENTS.md](../dicom-importer-core/AGENTS.md) and in that
package's `src/fhir/dates.ts`.

## Shape

- `src/settings-picker.tsx` — a free-text zone field with a `datalist` of
  likely zones (this runtime's own first, then `UTC`), so any IANA name can be
  typed and the common ones need no typing. Every keystroke is reported up
  through `SettingsPickerProps.onChange` verbatim — the shell owns the
  settings. A name the runtime cannot resolve is flagged inline
  (`aria-invalid` plus a `role="alert"` message) rather than swallowed, since
  `decodeDicom` fails on it.
- `src/index.ts` — public API barrel.

## Layering

- **Depends on**: `dicom-importer-core` (the `DicomSettings` type and
  `runtimeTimeZone`), `importer-fundamentals` (`SettingsPickerProps`),
  `effect` (`DateTime.zoneMakeNamed`, to tell a known zone from a typo),
  `react`.
- **Depended on by**: `importer-react` (registry entry).

## References

- [dicom-importer-core AGENTS.md](../dicom-importer-core/AGENTS.md)
- [importer-react AGENTS.md](../importer-react/AGENTS.md)
