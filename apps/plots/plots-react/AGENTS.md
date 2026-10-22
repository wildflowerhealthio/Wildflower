# AGENTS.md — apps/plots/plots-react

Plots' **browser layer**: one Observable Plot figure that draws
the `PointSeries` and `LevelSeries` of `plots-fundamentals` on the value
axes `ValueAxis.assign` gives them, and its `SpanSeries` as lanes under the
time axis, the same selection as a table or a scatter, and the controls
around them — the series panel over `plots-core-js`'s catalogue, the range
presets, the view switch, and the page layout. It imports no domain package and no FHIR type — whatever a series
stands for, the chart sees only points, levels, a unit, a label and the
presentation fields the domain chose, and the panel sees only catalogue rows
and opaque series ids.

## Shape

- `src/multi-axis-chart.tsx` — `MultiAxisChart` (`series`, `colours`,
  `lanes`, `xDomain`, `onHover`): the value series in selection order, put on
  axes by `ValueAxis.assign`; the legend, the figure, and the crosshair, whose
  stops and rule take in the lanes too. Each series wears the slot `colours`
  gives it (`useColourSlots`, held by the page); lines draw in
  selection order, so the series picked last is on top, while the legend and
  tooltip list series axis by axis; the crosshair snaps to
  `Crosshair.nearestStop` over `Crosshair.stops`. Which series are drawn as
  buckets is `Buckets.ofDenseSeries` at `bucketCountFor` the figure's width,
  decided once per render and handed to the marks, the stops and the tooltip
  alike.
- `src/chart-marks.ts` — `chartOptions`, the figure's marks, bottom layer
  first:
  - a value axis per `ValueAxis` (ticks from the axis, labels mapped back
    through `ValueAxis.denormalise`), two per side stepping outward. An axis
    with one series wears its colour and its `labelWithUnit`; a shared axis
    (one with a `sharedUnit`) wears `NEUTRAL_COLOUR` (a neutral text
    step) and that unit alone (`axisLabel`), and its series keep their own
    colours;
  - bands: a point series' readings' `low` / `high` as an area, a level
    series' levels' as one rectangle each, and a bucketed series' min–max
    envelope as an area in place of its readings' band;
  - a point series as a line with dots, `step-after` when its interpolation
    is `'step'` and straight otherwise;
  - a bucketed point series — more readings in the window than
    `bucketCountFor` (one bucket per `BUCKET_WIDTH` = 10px of frame, about a
    dot across) — as a line through each bucket's mean with no dots, curved
    as its interpolation says. `bucketVertices` breaks the line and envelope
    with a `NaN` vertex across a left-out slice and stretches each run to its
    slices' edges, so a lone bucket still draws;
  - a level series as `step-after` lines, one per `LevelRun` — a run breaks at
    a gap and where `lineStyle` changes, and an open level runs to the end of
    `xDomain`. `LINE_STYLE_DASH_ARRAY` is what `'dashed'` strokes with;
  - a span series as a lane under the time axis' labels: its label, a faint
    track, and a `Plot.rectX` bar per span (`aria-description="span lane"`) in
    its category's `--color-span-N`, clamped to `xDomain` rather than clipped
    (the lane sits outside the frame). Each lane grows the figure and its
    bottom margin by `LANE_HEIGHT`, so the frame keeps its height; past
    `SpanSeries.LANE_CAP` lanes `chartOptions` throws.
- `src/crosshair-tooltip.tsx` — `CrosshairTooltip`: one row per value series,
  axis by axis, with `Series.levelAt`'s value, unit and `note`; the detail
  line is the reading's date for a point series and `start – end` (or
  `ongoing`) for a level series.
  A bucketed series' row reads `Buckets.at` instead: the bucket mean in the
  unit, detailed `mean of n readings, min–max`. Each lane then lists a row per
  span under the crosshair (`SpanSeries.spansAt`) — its category, the lane's
  label, its start and end — or one `—` row in a gap.
- `src/legend.tsx` — `Legend`, the key above the figure: an entry per value
  series, axis by axis, naming its axis' side, then one per lane listing its
  categories (`laneCategories`, which `MultiAxisChart` derives once per lane
  with `SpanSeries.categoriesOf`).
- `src/series-colors.ts` — `seriesColors`, the `--color-series-N` /
  `-soft` tokens for a palette index, and `spanColour`, the `--color-span-N`
  token for a span category's colour slot (`NEUTRAL_COLOUR` for `null`).
- `src/value-format.ts` — tick, value and date formatting: `tickDecimals`
  (as many decimals as a tick step needs), `axisTickFormat` (the time chart's
  `0..1` ticks mapped back to values) and `valueTickFormat` (the scatter's
  value ticks), `formatReading` for a readout value and `readingWithUnit` for
  a reading with its unit and note, as the crosshair readout and the scatter's
  tip both write it.
- `src/use-colour-slots.ts` — `useColourSlots`: `ColourSlots.assign` over
  the selected value series in selection order, carried across renders. The
  page holds it above the view switch and hands it to `MultiAxisChart` and
  `ScatterChart`, so a series keeps its colour across views.
- `src/use-plot.ts` — `usePlotContainer` measures the container a figure
  mounts into, and `usePlot` mounts the figure there and redraws it at that
  width. Two hooks so the chart knows its width before it builds its marks.
- `src/series-panel.tsx` — `SeriesPanel` (`catalogGroups`,
  `selectedSeriesIds`, `onSelectionChange`): a search box filtering rows
  through core's `matchesSearch`, each `CatalogGroup` as a heading that folds
  (a button with `aria-expanded`) and counts its rows — "n of m" while a query
  is typed — and a react-tundraish `Checkbox` per row with its label, unit,
  count (readings for a point series, periods for a level series) and month
  span. At `ValueAxis.CAP` value series the unchecked point and level rows are
  disabled and a `role="status"` hint says "Up to 4 series at once"; span rows
  count against `SpanSeries.LANE_CAP` on their own ("Up to 2 lanes at once"),
  by their row's `seriesKind`. A Clear action empties the selection.
- `src/range-presets.tsx` — `RangePresets` (`selectedPreset`,
  `onPresetChange`): react-tundraish's `SegmentedToggle` over core's
  `RANGE_PRESETS`, one `aria-pressed` button each.
- `src/view-switch.tsx` — `ViewSwitch` (`shownView`, `scatterAxes`,
  `onViewChange`): `SegmentedToggle` over core's `PLOT_VIEWS` (Chart · Table ·
  Scatter), Scatter disabled unless core's `scatterAxesOf` paired two value
  series; and `ScatterUnavailableNote`, the `role="status"` line saying why
  (`Scatter needs two series selected`, `… one more …`, `… only two …`),
  rendered above the toolbar, or nothing.
- `src/series-table.tsx` — `SeriesTable` (`series`, `timeWindow`): the rows
  `ReadingTable.of` returns as a `<table>`, a row header per instant in
  viewer-local date and time, a column per series headed `labelWithUnit` (a
  lane by its label); a value cell reads the value and its `note`, a lane's
  cell `<category> starts` / `ends`, one entry per line.
- `src/scatter-chart.tsx` — `ScatterChart` (`x`, `y`, `timeWindow`,
  `colours`): the
  `Scatter.of` pairs as one Observable Plot figure through `usePlot` — each
  axis fitted and ticked as `ValueAxis.domainFor` / `ticksFor` fit that
  series, its tick labels at the decimals their step needs
  (`valueTickFormat`, as the time chart's), and labelled `labelWithUnit`, an 8px dot per pair in the colour X
  keeps (`colours`) ringed in the surface colour, and a `Plot.pointer` tip on the nearest
  pair naming its time and both values. X readings with no Y value are counted
  in a note under the figure.
- `src/plots-layout.tsx` — `PlotsLayout` (`seriesPanel`,
  `selectedSeriesCount`, `rangePresets`, `viewSwitch`, `toolbarNote`,
  `status`, the view as `children`): from 900px an 18rem sticky panel column
  beside the view; narrower, one column with the panel folded behind a
  `Series (n selected)` disclosure above it. The toolbar note when there is
  one, the toolbar row (presets, then view switch), then the status line when
  there is one, sit above the view in both.

## Rules

- **Draw what fundamentals computes; decide nothing.** Domains, ticks, sides,
  stops, the level in effect and the colour a series keeps are fundamentals'
  functions. How a series is drawn — interpolation, line style, value scale,
  the readout's note — is the domain package's choice, carried on the series.
  A mark here branches only on `Series.kind` and on whether
  `Buckets.ofDenseSeries` bucketed the series; a lane's colours are the
  category's `colourSlot`, never a series slot.
- **No domain imports.** Among the slice's packages this one depends on
  `plots-fundamentals` and `plots-core-js` only — core for the
  catalogue rows, the search and the range presets. A test fixture is a
  synthetic `PointSeries` / `LevelSeries`
  (`series-arbitraries.test-helpers.ts`) or `CatalogRow`, not an observation or
  a dose.
- **The selection, the range and the view are the caller's state.**
  `SeriesPanel`, `RangePresets` and `ViewSwitch` propose the next value through their callbacks and hold
  nothing but search text and fold state. A toggled series is appended to or
  removed from the selection, so selection order — the order axes take their
  sides in — is the order the reader picked.
- **Series ids are opaque to the panel.** It compares a row's `id` with the
  selected ids and never parses one, so a new domain's rows need no change
  here. Its caps are counted by the core's `selectionCapsOf` and `capIsFull`,
  from the selected ids' kinds, so a selected series whose row has not loaded
  yet still counts.
- **The narrow-width disclosure is a button, not `<details>`.** A closed
  `<details>` hides its content whatever the CSS says, so one panel could not
  both dock on a wide viewport and fold on a narrow one; the 900px breakpoint
  lives only in `plots-layout.module.css`.
- **Nested-list tests query with `:scope >`.** A group `<li>` also contains its
  rows' text, so a row is the `listitem` whose direct child is the checkbox
  label.
- **The chart is the one sanctioned multi-axis overlay.** The dataviz
  guidance's first anti-pattern is a second y-scale; this viewer exists to
  read one series against another it moves, so the overlay is the product (the
  epic's decision log records it). Every other dataviz rule holds: colours come
  from `ColourSlots.assign` in fixed palette order and never cycle, a series
  keeps its colour while it stays selected, a series colour paints marks, its
  own axis' lines and legend keys only (a shared axis is neutral) — tick
  labels, the legend and the tooltip wear the text tokens — and dark mode
  comes from the tokens, never a chart-local colour.
- **Plot's axis label ignores `dx`.** A stacked axis shifts its ticks with
  `dx` but places its label from the frame edge, so each axis sets its own
  `labelOffset` to the far side of its gutter; drop that and the labels on one
  side draw on top of each other.
- **A Plot mark option that is not a colour or number is read as a field
  name.** `ariaLabel: 'band'` on a mark is a channel looked up on each datum,
  so every datum is undefined and the mark silently renders nothing. Axis
  marks are the exception: their `ariaLabel` is a prefix.
- **jsdom has no layout.** Plot still renders its element structure and
  `aria-label`s there, and the tests read those: `svg > g[aria-label="line"]`,
  `"dot"`, `"area"`, `"rect"`, `"y-axis tick"`. `usePlot` falls back to
  Plot's default width where there is no `ResizeObserver`.
