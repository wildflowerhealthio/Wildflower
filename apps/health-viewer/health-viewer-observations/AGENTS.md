# AGENTS.md — apps/health-viewer/health-viewer-observations

The health viewer's **observation source**: how FHIR R4 `Observation`s become
plottable point series, exported as one `SeriesSource` value —
`observationSource`. Everything that knows what an observation _means_ lives
here; the chart math it feeds lives in `health-viewer-fundamentals`.

## Shape

- `src/observation-series.ts` — `observationsToSeries` (the descriptor's
  `read`): decoded `Observation`s → `ObservationSeries` (a `PointSeries` plus
  its `key` and `category`), with `undated` / `dropped` counts. Also the value
  presentation: a boolean steps on a `'zero-to-one'` axis, every other value
  type is a linear line on a `'fitted'` one.
- `src/observation-series-key.ts` — `ObservationSeriesKey` (`system`, `code`,
  `unit`) and its id grammar under the `o` prefix:
  `o:<system>|<code>|<unit>`, written through `SeriesId`.
- `src/observation-groups.ts` — the catalogue grouping by
  `Observation.category`: `CATEGORY_ORDER`, the labels, `OTHER_GROUP`, and
  `observationGroupIdOf`.
- `src/source.ts` — `observationSource`, the package's surface: `name:
'observations'`, `idPrefix: 'o'`, the groups, the reader, the key grammar and
  the grouping, in one value.

## Rules

- **The observation id is external contract.** `o:<system>|<code>|<unit>` is
  what a shared URL carries, so changing the field order, the prefix, or
  `SeriesId`'s escaping invalidates every link a patient has already saved.
  `observation-series-key.test.ts` pins it against an independent spelling of
  the grammar. `parseObservationSeriesId` never throws — a URL is
  user-editable, so a malformed entry is dropped, not raised.
- **The unit is part of a series' identity.** The same LOINC code reported in
  `mmol/L` and in `mg/dL` is two series. One line that silently changes scale
  mid-plot is a clinical hazard, not a convenience.
- **A `valueSampledData` is many readings.** Each numeric sample is one point
  at the observation's `effectivePeriod.start` (else `effectiveDateTime`, else
  `effectiveInstant`) + index × `period`, worth `origin + factor × sample`.
  `E`, `L` and `U` are skipped without shifting the samples after them. `issued`
  never dates samples, only `dimensions: 1` plots, and an observation whose
  readings are only partly dated counts as `undated` whole. The unit is
  `origin.unit` before `origin.code`, as for a quantity, so FHIR Sync for
  Pebble's heart rate is keyed `beats/minute` — a separate series from heart
  rate stored as `/min`, since nothing converts between units.
- **Nothing disappears silently.** `observationsToSeries` returns `undated` and
  `dropped` counts alongside the series, and every input moves at most one of
  them, so the UI can say what it could not plot.
- **The category grouping is domain knowledge.** Which `Observation.category`
  codes get their own heading, in what order, and that anything else files
  under `other` is decided here; the core only lays out the groups a source
  declares.
- **This package is a `fhir-r4` consumer**, so both
  [consumer gotchas](../../../slices/emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
  apply. The `value[x]` / `effective[x]` choice slots type as `any` on a
  decoded resource, and a decoded `Coding.system` is a `URL` while the wire
  form is a string — so the reader reads the resource as `unknown` through a
  permissive local schema that accepts both shapes. And `vp pack` (not
  `vp check`) is the gate for the TS2883 dts trap: run
  `vp run -F health-viewer-observations build` when the reader's inferred
  types change.

## References

- [apps/health-viewer/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [health-viewer-fundamentals AGENTS.md](../health-viewer-fundamentals/AGENTS.md)
  — the vocabulary this package reads into.
- [fhir-r4 Consumer Gotchas Reference](../../../slices/emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
