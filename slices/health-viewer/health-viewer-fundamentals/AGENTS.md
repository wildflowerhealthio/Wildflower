# AGENTS.md — slices/health-viewer/health-viewer-fundamentals

The health viewer's plot vocabulary, free of any medical domain: what a chart
draws (readings and held values), how its value axes are fitted, where its
crosshair snaps, which colour a series keeps, and "a domain source" as one
value. Domain packages (`health-viewer-observations`) read their records into
these types; `health-viewer-core` and the React layer draw them without knowing
what a reading or a dose is.

## Namespaces

One namespace per module, in the `effect` style: the file is the noun, the
principal type shares the namespace's name (`PointSeries.PointSeries`), and
functions read in the namespace's context (`ValueAxis.assign`, not
`assignAxes`). All are exported from the **flat root entry**:
`import { PointSeries, ValueAxis, Crosshair } from 'health-viewer-fundamentals'`.

- **`Level`** (`src/level.ts`) — a value held from `start` until `end` (both
  inclusive; `end: null` = open), with an optional band (`low` / `high`) and an
  optional `note` the domain supplies for a readout (`per day`). Absent keys,
  never `undefined` or `null`, for the optional fields. `inEffectAt(levels,
time)` is the one lookup every crosshair read goes through: the
  latest-starting level that covers `time`, or `null` in a gap.
- **`PointSeries`** (`src/point-series.ts`) — readings (`Point`: `time`,
  `value`, band, `note`) plus an `Interpolation` (`'linear' | 'step'`).
  `toLevels` reads a series as levels: each reading held until the next, the
  last one open-ended, so the levels never overlap. `levelAt` is the same
  lookup by binary search, with one deliberate difference from
  `Level.inEffectAt`: before the first reading it still names the first one.
- **`LevelSeries`** (`src/level-series.ts`) — values held over intervals, each
  a `StyledLevel` with a `LineStyle` (`'solid' | 'dashed'`) the domain decides.
  Levels may overlap or leave gaps. `levelAt` reads through
  `Level.inEffectAt`, with no fallback.
- **`Series`** (`src/series.ts`) — `Series = PointSeries | LevelSeries`,
  discriminated on `kind` (`'points' | 'levels'`). Both carry an opaque `id`,
  `label`, `unit` and a `ValueScale` (`'fitted' | 'from-zero' |
'zero-to-one'`). `levelsOf` is the one place the two kinds are told apart;
  `levelAt`, `extentOf` and `sizeOf` read through it.
- **`ValueAxis`** (`src/value-axis.ts`) — one value axis per series: `assign`
  (sides alternate in selection order, `CAP` = 4 axes), `domainFor` (fitted as
  the series' `valueScale` says), `niceDomain`, `ticksFor` (never `-0`),
  `normalise` / `denormalise`.
- **`Crosshair`** (`src/crosshair.ts`) — `stops(series, window)`: every level
  boundary inside the window, sorted and distinct, so a point series' stops are
  its reading times; `nearestStop` snaps the pointer to one.
- **`ColourSlots`** (`src/colour-slots.ts`) — `assign(previous, selectedIds)`:
  a series keeps its colour while it stays selected; newcomers take the lowest
  free slot; throws past `ValueAxis.CAP`.
- **`TimeDomain`** (`src/time-domain.ts`) — a closed `[start, end]` interval,
  `contains`, `pointsWithin`.
- **`SeriesId`** (`src/series-id.ts`) — the escaped field grammar every series
  id is written in: `fromFields(prefix, fields)` →
  `<prefix>:<field>|<field>|…`, `|` and `\` escaped, `null` as `\~`;
  `toFields(prefix, id)` is its exact inverse and reads only spellings
  `fromFields` writes, so an id that parses is already canonical.
- **`SeriesSource`** (`src/series-source.ts`) — "a health-viewer domain
  source" as one value, the analogue of `http-extraction-fundamentals`'
  `SourceDescriptor`: `name`, `idPrefix`, catalogue `groups`, `read`,
  `seriesIdOf` / `parseSeriesId`, `groupIdOf`. `read` returns a `Reading` —
  the series plus `undated` / `dropped` counts. `make` clones and deep-freezes.

## Why `read` is on the descriptor

A domain package's whole surface is its `SeriesSource` value, the way
`fhir-r4-source`'s is `fhirR4Source`: registering a domain is appending one
value to `health-viewer-core`'s closed list. Each domain reads different
resources (observations; requests and statements for medications), so the
resource type is a type parameter and the core still hands each source its own
resources by name — the one thing a generic loop cannot do. The key grammar
(`seriesIdOf` / `parseSeriesId`) sits beside it, so the id a series carries and
the parser a URL goes through come from the same value.

## Rules

- **This package imports from no slice.** Its dependencies are exactly
  `effect` and `kitchen-sink`: no `fhir-r4`, no `medication-core`, no
  `health-viewer-*`. A domain concept that wants to live here is a sign the
  vocabulary is missing a presentation word — add the word, not the domain.
- **Chart math is decided here, once.** Value domains, ticks, axis sides, the
  crosshair's stops and lookup, colour assignment — all pure functions over
  `Series`, property-tested. A renderer draws what these return and re-derives
  none of it.
- **The domain decides presentation; this package applies it.** Which
  `Interpolation`, `ValueScale`, `LineStyle` and `note` a series gets is the
  domain package's call (a boolean steps on `[0, 1]`, a dose axis starts at
  zero, an inferred extent is dashed). Nothing here branches on what a series
  means.
- **`SeriesId`'s escaping is external contract.** Shared URLs carry ids written
  through `fromFields`, so changing the escaping or the null marker invalidates
  every link already saved. `toFields` never throws.
- **`ValueAxis.CAP` is a rendering limit.** `ValueAxis.assign` and
  `ColourSlots.assign` throw past it rather than truncating, so a selection UI
  caps against the constant instead of discovering a series vanished.

## References

- [slices/health-viewer/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [http-extraction-fundamentals AGENTS.md](../../http-extraction/http-extraction-fundamentals/AGENTS.md)
  — the structure this package mirrors.
- [Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
  — property tests are the default here.
