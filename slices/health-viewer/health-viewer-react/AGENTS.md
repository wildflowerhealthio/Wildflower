# AGENTS.md — slices/health-viewer/health-viewer-react

The health viewer's **browser layer**: one Observable Plot figure that draws
the `PointSeries` and `LevelSeries` of `health-viewer-fundamentals` on the value
axes `ValueAxis.assign` gives them. It imports no domain package and no FHIR
type — whatever a series stands for, the chart sees only points, levels, a
unit, a label and the presentation fields the domain chose.

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

## Rules

- **Draw what fundamentals computes; decide nothing.** Domains, ticks, sides,
  stops, the level in effect and the colour a series keeps are fundamentals'
  functions. How a series is drawn — interpolation, line style, value scale,
  the readout's note — is the domain package's choice, carried on the series.
  A mark here branches only on `Series.kind`.
- **No domain imports.** This package depends on `health-viewer-fundamentals`
  alone among the slice's packages. A test fixture is a synthetic
  `PointSeries` / `LevelSeries` (`series-arbitraries.test-helpers.ts`), not an
  observation or a dose.
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
