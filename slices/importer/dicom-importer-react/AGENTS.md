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
  likely zones, so any IANA name can be typed and the common ones need no
  typing. The field holds keystrokes locally and reports up through
  `react-kitchen-sink`'s `useDebouncedCallback` on a 400ms debounce (flushed
  on blur or Enter), because each report re-decodes every DICOM file in the
  batch and re-runs the server comparison. It reports only a zone the runtime
  can resolve: every half-typed prefix of `America/Toronto` is itself a name
  the runtime rejects, and committing those would flip each file to "could not
  be read" and back on the way through. An unresolvable name is flagged inline
  (`aria-invalid` plus a `role="alert"` message) instead, and the decode
  carries on under the last zone that did resolve. The draft seeds from
  `settings.timeZone` on mount and is not re-seeded, so a commit echoing back
  as a prop cannot clobber keystrokes typed since; a caller that must force a
  zone in remounts the picker under a React `key`.
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
  `runtimeTimeZone`), `importer-fundamentals` (`SettingsPickerProps`),
  `react-kitchen-sink` (`useDebouncedCallback`), `effect`
  (`DateTime.zoneMakeNamed`, to tell a known zone from a typo), `react`.
- **Depended on by**: `importer-react` (registry entry).

## References

- [dicom-importer-core AGENTS.md](../dicom-importer-core/AGENTS.md)
- [importer-react AGENTS.md](../importer-react/AGENTS.md)
