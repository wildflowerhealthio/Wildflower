# AGENTS.md — slices/health-viewer

The **Synthesized Health Viewer**: a patient's own observations and
medications plotted on one time axis, so a reader can see a lab result against
the dose that was running when it was taken.

## Packages

- `health-viewer-core` — the pure viewer layer, and currently the whole slice.
  The plottable series model (`SeriesKey` and its escaped string form, the
  observation point and the dose segment), the FHIR R4 `Observation` → series
  adapter, axis assignment with its value domains and ticks, the x-axis range
  presets, the catalogue panel's grouping and search, the URL codec a shared
  link round-trips through, and the crosshair lookup. No DOM, no React, no
  platform imports.

The dose-regimen → `MedicationSeries` mapping, the React layer, and the app
route are not built yet. The `DoseSegment` shape the mapping must produce is
defined in `health-viewer-core`'s `series.ts`, so the mapping only has to build
it rather than re-decide it.

## Rules

- **The core owns every decision the chart makes.** Which series exist, what
  each axis spans, what the crosshair reads, what a link encodes — all of it is
  a pure function here, so it can be property-tested exhaustively. A React
  adapter renders what this package returns; it does not re-derive any of it.
- **`seriesId` is external contract.** It is what a shared URL carries, so
  changing its grammar or escaping invalidates every link a patient has already
  saved. `parseSeriesId` is its exact inverse and never throws — a URL is
  user-editable, so a malformed entry is dropped, not raised.
- **The unit is part of a series' identity.** The same LOINC code reported in
  `mmol/L` and in `mg/dL` is two series. One line that silently changes scale
  mid-plot is a clinical hazard, not a convenience.
- **Nothing disappears silently.** `observationsToSeries` returns `undated` and
  `dropped` counts alongside the series, and every input moves at most one of
  them, so the UI can say what it could not plot.
- **This package is a `fhir-r4` consumer**, so both
  [consumer gotchas](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
  apply. The `value[x]` / `effective[x]` choice slots type as `any` on a
  decoded resource, and a decoded `Coding.system` is a `URL` while the wire
  form is a string — so the adapter reads the resource as `unknown` through a
  permissive local schema that accepts both shapes, exactly as
  `medication-core/fhir` does. And `vp pack` (not `vp check`) is the gate for
  the TS2883 dts trap: run `vp run -F health-viewer-core build` when the
  adapter's inferred types change.
- **Search tokenizes locally rather than reusing `medication-core`'s
  `normalizeName`.** That one drops numbers and dosage units as matching noise,
  which is right for drug names and wrong here: `a1c`, `24h` and `mmol` are
  exactly what a reader types into a catalogue.
- **`AXIS_CAP` is a rendering limit.** `assignAxes` throws past it rather than
  truncating, so a selection UI caps against the constant instead of
  discovering a series vanished.

## References

- [Architecture / slice layering](../AGENTS.md)
- [fhir-r4 Consumer Gotchas Reference](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md) — property tests are the default here
