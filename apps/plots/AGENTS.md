# AGENTS.md — apps/plots

**Plots**: a patient's own observations and
medications plotted on one time axis, so a reader can see a lab result against
the dose that was running when it was taken. The app and every package it is
built from live here; only the medication fundamentals it reads
(`slices/medication`'s `medication-core`) are shared with another product.

## Packages

The folder is layered like `http-extraction`: a domain-free vocabulary, one
package per kind of record, and an assembly on top.

```text
plots-fundamentals   plot vocabulary and chart math; imports no slice
      ▲
plots-observations   FHIR R4 Observation → PointSeries, SpanSeries
plots-medications    medication-core DoseRegimen → LevelSeries
      ▲
plots-core-js           closed list of sources, catalogue, URL codec, range presets
      ▲
plots-react          the Plot chart, series panel, range presets and page layout
```

- **`plots-fundamentals`** — the plot vocabulary, as `effect`-style
  namespaces from one flat entry: `Level`, `PointSeries`, `LevelSeries`,
  `SpanSeries` (labelled time spans, drawn as a lane), `Series`, `ValueAxis` (domains, ticks, axis assignment), `Buckets` (a dense
  series summarised per time slice), `Crosshair`,
  `ColourSlots`, `TimeDomain`, `SeriesId` (the escaped field grammar ids are
  written in) and `SeriesSource` (a domain source as one value). See its
  [AGENTS.md](./plots-fundamentals/AGENTS.md).
- **`plots-observations`** — the observation source,
  `observationSource`: FHIR R4 `Observation`s read into point series — and,
  for a coded value over an `effectivePeriod`, span series — the `o:`
  id grammar, and the catalogue grouping by `Observation.category`. See its
  [AGENTS.md](./plots-observations/AGENTS.md).
- **`plots-medications`** — the medication source,
  `medicationSource`: `MedicationRequest`s read through `medication-core`'s
  dose regimens into level series — one per medication, dose unit and dose
  basis, each level ending where the next request starts — the `m:` id
  grammar, and the Medications catalogue group. See its
  [AGENTS.md](./plots-medications/AGENTS.md).
- **`plots-core-js`** — the assembly: `SERIES_SOURCES` and `readRecord`,
  the catalogue panel's grouping and search, the range presets, and the URL
  codec a shared link round-trips through. See its
  [AGENTS.md](./plots-core-js/AGENTS.md).
- **`plots-react`** — the browser layer: `MultiAxisChart` draws the
  axes `ValueAxis.assign` returns as one Observable Plot figure — a
  colour-matched value axis per series, point series as lines with dots (or,
  too dense for dots, a bucket-mean line over a min–max envelope), level
  series as step lines broken at gaps and dashed where the domain says, `low` /
  `high` bands, span series as thin lanes under the time axis, a legend, and a
  crosshair readout of `Series.levelAt` per value series and
  `SpanSeries.spansAt` per lane. `SeriesPanel` lays out `groupForPanel`'s
  catalogue as searchable, collapsible groups of checkboxes capped at
  `ValueAxis.CAP` value series and `SpanSeries.LANE_CAP` lanes; `RangePresets`
  picks a `RangePreset`; `PlotsLayout` docks the panel beside the chart
  from 900px and folds it into a `Series (n selected)` disclosure below that.
  It imports no domain package. See its
  [AGENTS.md](./plots-react/AGENTS.md).

The app is [`plots-web`](./plots-web/AGENTS.md), published at
<https://plots.wildflowerhealth.io/> (tile `plots`), which
composes core and react around a SMART shell. A
new kind of record is a new package beside
`plots-observations` that exports a
`SeriesSource` and joins `SERIES_SOURCES` (and `RecordResources`), plus
the app's paged read for it in `useRecordRead`.

## Rules

- **Chart math is fundamentals'; domain decisions are the domain package's.**
  What each axis spans, where the crosshair snaps and what it reads, which
  colour a series keeps — pure functions over `Series` in
  `plots-fundamentals`, property-tested exhaustively. Which series a
  record holds, what each is labelled, how it is drawn (`Interpolation`,
  `ValueScale`, `LineStyle`, `note`) and which catalogue group it files under
  — the domain package's. `plots-react` renders what these return; it
  does not re-derive any of it, and it never reads a domain field.
- **Fundamentals imports from no slice**, and depends only on `effect` and
  `kitchen-sink`. A domain package adds the resource package it reads
  (`plots-observations` → `fhir-r4`; `plots-medications` →
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
- **`ValueAxis.CAP` and `SpanSeries.LANE_CAP` are rendering limits.**
  `ValueAxis.assign` throws past four value series and the chart past two
  lanes, rather than truncating, so a selection UI caps against the constants
  — each counted on its own, by the kind each source's `seriesKindOf` names —
  instead of discovering a series vanished.

## References

- [Architecture / slice layering](../../slices/AGENTS.md)
- [http-extraction AGENTS.md](../../slices/http-extraction/AGENTS.md) — the structure
  this folder mirrors.
- [fhir-r4 Consumer Gotchas Reference](../../slices/fhir/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md) — property tests are the default here
