# AGENTS.md — slices/health-viewer

The **Synthesized Health Viewer**: a patient's own observations and
medications plotted on one time axis, so a reader can see a lab result against
the dose that was running when it was taken.

## Packages

The slice is layered like `http-extraction`: a domain-free vocabulary, one
package per kind of record, and an assembly on top.

```text
health-viewer-fundamentals   plot vocabulary and chart math; imports no slice
      ▲
health-viewer-observations   FHIR R4 Observation → PointSeries
health-viewer-medications    medication-core DoseRegimen → LevelSeries
      ▲
health-viewer-core           closed list of sources, catalogue, URL codec, range presets
      ▲
health-viewer-react          the Plot chart, series panel, range presets and page layout
```

- **`health-viewer-fundamentals`** — the plot vocabulary, as `effect`-style
  namespaces from one flat entry: `Level`, `PointSeries`, `LevelSeries`,
  `Series`, `ValueAxis` (domains, ticks, axis assignment), `Buckets` (a dense
  series summarised per time slice), `Crosshair`,
  `ColourSlots`, `TimeDomain`, `SeriesId` (the escaped field grammar ids are
  written in) and `SeriesSource` (a domain source as one value). See its
  [AGENTS.md](./health-viewer-fundamentals/AGENTS.md).
- **`health-viewer-observations`** — the observation source,
  `observationSource`: FHIR R4 `Observation`s read into point series, the `o:`
  id grammar, and the catalogue grouping by `Observation.category`. See its
  [AGENTS.md](./health-viewer-observations/AGENTS.md).
- **`health-viewer-medications`** — the medication source,
  `medicationSource`: `MedicationRequest`s read through `medication-core`'s
  dose regimens into level series — one per medication, dose unit and dose
  basis, each level ending where the next request starts — the `m:` id
  grammar, and the Medications catalogue group. See its
  [AGENTS.md](./health-viewer-medications/AGENTS.md).
- **`health-viewer-core`** — the assembly: `SERIES_SOURCES` and `readRecord`,
  the catalogue panel's grouping and search, the range presets, and the URL
  codec a shared link round-trips through. See its
  [AGENTS.md](./health-viewer-core/AGENTS.md).
- **`health-viewer-react`** — the browser layer: `MultiAxisChart` draws the
  axes `ValueAxis.assign` returns as one Observable Plot figure — a
  colour-matched value axis per series, point series as lines with dots (or,
  too dense for dots, a bucket-mean line over a min–max envelope), level
  series as step lines broken at gaps and dashed where the domain says, `low` /
  `high` bands, a legend, and a crosshair readout of `Series.levelAt` per
  series. `SeriesPanel` lays out `groupForPanel`'s catalogue as searchable,
  collapsible groups of checkboxes capped at `ValueAxis.CAP`; `RangePresets`
  picks a `RangePreset`; `HealthViewerLayout` docks the panel beside the chart
  from 900px and folds it into a `Series (n selected)` disclosure below that.
  It imports no domain package. See its
  [AGENTS.md](./health-viewer-react/AGENTS.md).

The app is [`apps/health-viewer`](../../apps/health-viewer/AGENTS.md)
(`health-viewer-app`), which composes core and react around a SMART shell. A
new kind of record is a new package beside
`health-viewer-observations` that exports a
`SeriesSource` and joins `SERIES_SOURCES` (and `RecordResources`), plus
the app's paged read for it in `useRecordRead`.

## Rules

- **Chart math is fundamentals'; domain decisions are the domain package's.**
  What each axis spans, where the crosshair snaps and what it reads, which
  colour a series keeps — pure functions over `Series` in
  `health-viewer-fundamentals`, property-tested exhaustively. Which series a
  record holds, what each is labelled, how it is drawn (`Interpolation`,
  `ValueScale`, `LineStyle`, `note`) and which catalogue group it files under
  — the domain package's. `health-viewer-react` renders what these return; it
  does not re-derive any of it, and it never reads a domain field.
- **Fundamentals imports from no slice**, and depends only on `effect` and
  `kitchen-sink`. A domain package adds the resource package it reads
  (`health-viewer-observations` → `fhir-r4`; `health-viewer-medications` →
  `medication-core`, which owns reading a regimen off a request).
- **Series ids are external contract.** They are what a shared URL carries, so
  changing a domain's key grammar, its prefix, or `SeriesId`'s escaping
  invalidates every link a patient has already saved. Each source's
  `parseSeriesId` is the exact inverse of its `seriesIdOf` and never throws — a
  URL is user-editable, so a malformed entry is dropped, not raised.
- **The unit is part of a series' identity.** The same LOINC code reported in
  `mmol/L` and in `mg/dL` is two series, and so are one drug's doses per
  administration and per day. One line that silently changes scale mid-plot is
  a clinical hazard, not a convenience.
- **Nothing disappears silently.** Every source's `read` returns `undated` and
  `dropped` counts alongside its series, every input moves at most one of them,
  and `readRecord` carries them up, so the UI can say what it could not plot.
- **`ValueAxis.CAP` is a rendering limit.** `ValueAxis.assign` throws past it
  rather than truncating, so a selection UI caps against the constant instead
  of discovering a series vanished.

## References

- [Architecture / slice layering](../AGENTS.md)
- [http-extraction AGENTS.md](../http-extraction/AGENTS.md) — the structure
  this slice mirrors.
- [fhir-r4 Consumer Gotchas Reference](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md) — property tests are the default here
