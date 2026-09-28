# AGENTS.md — slices/health-viewer/health-viewer-react

The health viewer's **browser layer**: one Observable Plot figure that draws
the `PointSeries` and `LevelSeries` of `health-viewer-fundamentals` on the value
axes `ValueAxis.assign` gives them, and the controls around it — the series
panel over `health-viewer-core`'s catalogue, the range presets, and the page
layout. It imports no domain package and no FHIR type — whatever a series
stands for, the chart sees only points, levels, a unit, a label and the
presentation fields the domain chose, and the panel sees only catalogue rows
and opaque series ids.

## Shape

- `src/multi-axis-chart.tsx` — `MultiAxisChart` (`axes`, `xDomain`,
  `onHover`): the legend, the figure, and the crosshair. Colours come from
  `ColourSlots.assign`, carried across renders; the crosshair snaps to
  `Crosshair.nearestStop` over `Crosshair.stops`.
- `src/chart-marks.ts` — `chartOptions`, the figure's marks, bottom layer
  first:
  - a value axis per `ValueAxis` (ticks from the axis, labels mapped back
    through `ValueAxis.denormalise`), two per side stepping outward;
  - bands: a point series' readings' `low` / `high` as an area, a level
    series' levels' as one rectangle each;
  - a point series as a line with dots, `step-after` when its interpolation
    is `'step'` and straight otherwise;
  - a level series as `step-after` lines, one per `LevelRun` — a run breaks at
    a gap and where `lineStyle` changes, and an open level runs to the end of
    `xDomain`. `LINE_STYLE_DASH_ARRAY` is what `'dashed'` strokes with.
- `src/crosshair-tooltip.tsx` — `CrosshairTooltip`: one row per axis with
  `Series.levelAt`'s value, unit and `note`; the detail line is the reading's
  date for a point series and `start – end` (or `ongoing`) for a level series.
- `src/legend.tsx` — `Legend`, the key above the figure.
- `src/series-colors.ts` — `seriesColors`, the `--color-series-N` /
  `-soft` tokens for a palette index.
- `src/value-format.ts` — tick, value and date formatting.
- `src/use-plot.ts` — `usePlot`: mounts a figure into a container and redraws
  it at the container's width.
- `src/series-panel.tsx` — `SeriesPanel` (`catalogGroups`,
  `selectedSeriesIds`, `onSelectionChange`): a search box filtering rows
  through core's `matchesSearch`, each `CatalogGroup` as a heading that folds
  (a button with `aria-expanded`) and counts its rows — "n of m" while a query
  is typed — and a react-tundraish `Checkbox` per row with its label, unit,
  count (readings for a point series, periods for a level series) and month
  span. At `ValueAxis.CAP` the unchecked rows are disabled and a `role="status"`
  hint says "Up to 4 series at once"; a Clear action empties the selection.
- `src/range-presets.tsx` — `RangePresets` (`selectedPreset`,
  `onPresetChange`): react-tundraish's `SegmentedToggle` over core's
  `RANGE_PRESETS`, one `aria-pressed` button each.
- `src/health-viewer-layout.tsx` — `HealthViewerLayout` (`seriesPanel`,
  `selectedSeriesCount`, `rangePresets`, `status`, the chart as `children`):
  from 900px an 18rem sticky panel column beside the chart; narrower, one
  column with the panel folded behind a `Series (n selected)` disclosure above
  the chart. The presets row, then the status line when there is one, sit
  above the chart in both.

## Rules

- **Draw what fundamentals computes; decide nothing.** Domains, ticks, sides,
  stops, the level in effect and the colour a series keeps are fundamentals'
  functions. How a series is drawn — interpolation, line style, value scale,
  the readout's note — is the domain package's choice, carried on the series.
  A mark here branches only on `Series.kind`.
- **No domain imports.** Among the slice's packages this one depends on
  `health-viewer-fundamentals` and `health-viewer-core` only — core for the
  catalogue rows, the search and the range presets. A test fixture is a
  synthetic `PointSeries` / `LevelSeries`
  (`series-arbitraries.test-helpers.ts`) or `CatalogRow`, not an observation or
  a dose.
- **The selection and the range are the caller's state.** `SeriesPanel` and
  `RangePresets` propose the next value through their callbacks and hold
  nothing but search text and fold state. A toggled series is appended to or
  removed from the selection, so selection order — the order axes take their
  sides in — is the order the reader picked.
- **Series ids are opaque to the panel.** It compares a row's `id` with the
  selected ids and never parses one, so a new domain's rows need no change
  here.
- **The narrow-width disclosure is a button, not `<details>`.** A closed
  `<details>` hides its content whatever the CSS says, so one panel could not
  both dock on a wide viewport and fold on a narrow one; the 900px breakpoint
  lives only in `health-viewer-layout.module.css`.
- **Nested-list tests query with `:scope >`.** A group `<li>` also contains its
  rows' text, so a row is the `listitem` whose direct child is the checkbox
  label.
- **The chart is the one sanctioned multi-axis overlay.** The dataviz
  guidance's first anti-pattern is a second y-scale; this viewer exists to
  read one series against another it moves, so the overlay is the product (the
  epic's decision log records it). Every other dataviz rule holds: colours come
  from `ColourSlots.assign` in fixed palette order and never cycle, a series
  keeps its colour while it stays selected, a series colour paints marks, axis
  lines and legend keys only — tick labels, the legend and the tooltip wear the
  text tokens — and dark mode comes from the tokens, never a chart-local
  colour.
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
