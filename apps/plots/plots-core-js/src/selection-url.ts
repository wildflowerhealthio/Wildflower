import { type Series, SpanSeries, ValueAxis } from '@wildflowerhealthio/plots-fundamentals'

import { type PlotView, isPlotView } from './plot-view.ts'
import { seriesKindOfId } from './series-sources.ts'
import { type RangePreset, isRangePreset } from './time-range.ts'

/**
 * What the viewer's URL carries of its own: what is plotted, over what
 * window, and in which view. Whose record is open is `smart-app-react`'s
 * `?patient=`, beside it.
 */
interface Selection {
  /**
   * The plotted series' ids, in selection order — the order that decides axis
   * sides and lane order. Distinct, with at most `ValueAxis.CAP` point or
   * level series and at most `SpanSeries.LANE_CAP` span series. Opaque here:
   * each id belongs to the source whose prefix it carries, which says its
   * kind.
   */
  readonly series: readonly string[]
  readonly range: RangePreset
  readonly view: PlotView
}

/**
 * How many of each of a selection's two caps it uses: point and level series
 * against `ValueAxis.CAP`, span series (lanes) against `SpanSeries.LANE_CAP`.
 */
interface SelectionCaps {
  readonly valueSeriesCount: number
  readonly laneCount: number
}

/** The caps an empty selection uses. */
const NO_CAPS_USED: SelectionCaps = { valueSeriesCount: 0, laneCount: 0 }

/** Whether `caps` has no room left for another series of `kind`. */
const capIsFull = (caps: SelectionCaps, kind: Series.Series['kind']): boolean =>
  kind === 'spans' ? caps.laneCount >= SpanSeries.LANE_CAP : caps.valueSeriesCount >= ValueAxis.CAP

/** `caps` with one more series of `kind` counted. */
const withSeriesOfKind = (caps: SelectionCaps, kind: Series.Series['kind']): SelectionCaps =>
  kind === 'spans'
    ? { ...caps, laneCount: caps.laneCount + 1 }
    : { ...caps, valueSeriesCount: caps.valueSeriesCount + 1 }

/**
 * How the series `ids` stand against the two caps, each id counted by the
 * kind its source reads it as (`seriesKindOfId`) — so an id counts whether or
 * not the catalogue has a row for it yet. An id no source reads counts
 * against neither.
 */
const selectionCapsOf = (ids: Iterable<string>): SelectionCaps => {
  let caps = NO_CAPS_USED
  for (const id of ids) {
    const kind = seriesKindOfId(id)
    if (kind !== null) caps = withSeriesOfKind(caps, kind)
  }
  return caps
}

/** Query key repeated once per selected series. */
const SERIES_PARAM = 's'

/** Query key holding the {@link RangePreset}. */
const RANGE_PARAM = 'r'

/** Query key holding the {@link PlotView}. */
const VIEW_PARAM = 'v'

/** The preset a selection falls back to when the URL names none or names a bad one. */
const DEFAULT_RANGE: RangePreset = 'all'

/** The view a selection falls back to when the URL names none or names a bad one. */
const DEFAULT_VIEW: PlotView = 'chart'

/** Render a selection as query parameters — one `s` per series in order, one `r` and one `v`. */
const encodeSelection = (selection: Selection): URLSearchParams => {
  const params = new URLSearchParams()
  for (const id of selection.series) params.append(SERIES_PARAM, id)
  params.set(RANGE_PARAM, selection.range)
  params.set(VIEW_PARAM, selection.view)
  return params
}

/**
 * A copy of `params` with `selection` as its `s`, `r` and `v`, and every other
 * key kept as it was — the page's `?patient=` and anything else the URL
 * carries.
 */
const withSelection = (params: URLSearchParams, selection: Selection): URLSearchParams => {
  const selectionParams = new URLSearchParams(params)
  selectionParams.delete(SERIES_PARAM)
  selectionParams.delete(RANGE_PARAM)
  selectionParams.delete(VIEW_PARAM)
  for (const [key, value] of encodeSelection(selection)) selectionParams.append(key, value)
  return selectionParams
}

/**
 * Read a selection back out of query parameters. Never throws.
 *
 * @remarks
 * Everything unrecognised is dropped, not rejected: a URL is user-editable and
 * outlives the series it names, so one stale `s` must not cost the reader the
 * rest of their link. An `s` survives when some source can read it
 * (`seriesKindOfId`) — so an id whose source the viewer does not assemble,
 * or that its source would not have written, is dropped.
 * A repeated `s` keeps its first place. Only the first `ValueAxis.CAP` point
 * or level series and the first `SpanSeries.LANE_CAP` span series are kept,
 * each cap counted on its own — the chart draws no more, and it throws past
 * either cap rather than truncating, so a hand-edited link is cut here.
 * An absent or bad `r` means {@link DEFAULT_RANGE}, and an absent or bad `v`
 * {@link DEFAULT_VIEW}. A `v` naming a view the series cannot make is kept:
 * which view is shown is the page's `shownViewOf`.
 */
const decodeSelection = (params: URLSearchParams): Selection => {
  const series: string[] = []
  let caps = NO_CAPS_USED
  for (const id of new Set(params.getAll(SERIES_PARAM))) {
    const kind = seriesKindOfId(id)
    if (kind !== null && !capIsFull(caps, kind)) {
      series.push(id)
      caps = withSeriesOfKind(caps, kind)
    }
  }
  const range = params.get(RANGE_PARAM)
  const view = params.get(VIEW_PARAM)
  return {
    series,
    range: range !== null && isRangePreset(range) ? range : DEFAULT_RANGE,
    view: view !== null && isPlotView(view) ? view : DEFAULT_VIEW,
  }
}

export type { Selection, SelectionCaps }
export {
  DEFAULT_RANGE,
  DEFAULT_VIEW,
  RANGE_PARAM,
  SERIES_PARAM,
  VIEW_PARAM,
  capIsFull,
  decodeSelection,
  encodeSelection,
  selectionCapsOf,
  withSelection,
}
