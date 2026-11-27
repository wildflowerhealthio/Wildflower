# AGENTS.md — slices/importer/dicom-importer-react

The **DICOM UI** for the importer slice: the `DicomSettingsPicker` (the
equipment time zone — the one knob the format has) and the
`DicomFilePreview` (re-exported from `dicom-react`: identifying tags under
a cornerstone-rendered image) for the server source file list's preview dialog.
The DICOM format needs no interactive review body; the shell's generalized
sectioned review covers it.

Why a time zone is the knob at all is explained in
[dicom-importer-core AGENTS.md](../../../slices/importer/dicom-importer-core/AGENTS.md) and in that
package's `src/fhir/dates.ts`.

## Shape

- `src/settings-picker.tsx` — `react-tundraish`'s `TimeZoneField` over
  `suggestedTimeZones()`, so any IANA name can be typed and the common ones
  need no typing. The field keeps what is typed as its own draft and reports
  only a zone the runtime recognizes, 400ms after the last keystroke (flushed
  on blur or Enter), because each report re-decodes every DICOM file in the
  batch and re-runs the server comparison: every half-typed prefix of
  `America/Toronto` is itself a name the runtime rejects, and reporting those
  would flip each file to "could not be read" and back on the way through. An
  unrecognized name is flagged inline instead, and the decode carries on under
  the last zone that was recognized. A zone set from outside while the picker
  is mounted replaces what it shows; its own report echoing back does not.
- `src/time-zones.ts` — `NORTH_AMERICAN_TIME_ZONES` (one name per distinct
  civil zone, east to west, plus `UTC`) and `suggestedTimeZones()`, which puts
  this runtime's own zone first and drops the duplicate when it is already in
  the list. A plain module rather than part of the `.tsx` so the list is
  testable without rendering, and so the component file exports only
  components (`react(only-export-components)`). `America/Phoenix` and
  `America/Regina` earn their places by _not_ observing DST — the cases most
  easily got wrong by picking a neighbour.
- `src/index.ts` — public API barrel.

## Layering

- **Depends on**: `dicom-importer-core` (the `DicomSettings` type and
  `runtimeTimeZone`), `dicom-react` (`DicomFilePreview` re-export),
  `importer-fundamentals` (`SettingsPickerProps`), `react-tundraish`
  (`TimeZoneField`), `react`.
- **Depended on by**: `importer-react` (registry entry).

## References

- [dicom-importer-core AGENTS.md](../../../slices/importer/dicom-importer-core/AGENTS.md)
- [importer-react AGENTS.md](../importer-react/AGENTS.md)
