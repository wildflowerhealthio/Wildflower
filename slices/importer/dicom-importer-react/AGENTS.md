# AGENTS.md — slices/importer/dicom-importer-react

The **DICOM UI** for the importer slice: a no-op `DicomSettingsPicker` (no
user-facing knobs yet — D3 adds tag parsing). The DICOM format needs no
interactive review body; the shell's generalized sectioned review covers it.

## Shape

- `src/settings-picker.tsx` — renders nothing; the empty `DicomSettings` has
  no knobs the user could tune.
- `src/index.ts` — public API barrel.

## Layering

- **Depends on**: `dicom-importer-core` (the `DicomSettings` type),
  `importer-fundamentals` (`SettingsPickerProps`), `react`.
- **Depended on by**: `importer-react` (registry entry).

## References

- [dicom-importer-core AGENTS.md](../dicom-importer-core/AGENTS.md)
- [importer-react AGENTS.md](../importer-react/AGENTS.md)
