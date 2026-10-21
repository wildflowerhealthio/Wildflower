import { seriesKindOfId } from './series-sources.ts'

/**
 * How the viewer shows the selection: the time chart, a table of its
 * readings, or one series' readings scattered against another's values.
 */
type PlotView = 'chart' | 'table' | 'scatter'

/** Every {@link PlotView}, in the order the switch lists them. */
const PLOT_VIEWS: readonly PlotView[] = ['chart', 'table', 'scatter']

/** Whether `value` names a {@link PlotView} — the guard the URL codec decodes through. */
const isPlotView = (value: string): value is PlotView =>
  (PLOT_VIEWS as readonly string[]).includes(value)

/** How many value series a scatter plots: one along each axis. */
const SCATTER_SERIES_COUNT = 2

/**
 * Which series a scatter of the selection plots, or why it cannot be drawn.
 *
 * - `'paired'`: exactly two value series are selected; the first picked is X
 *   and the second Y.
 * - `'too-few-value-series'` / `'too-many-value-series'`: how many are
 *   selected instead.
 */
type ScatterAxes =
  | { readonly kind: 'paired'; readonly xSeriesId: string; readonly ySeriesId: string }
  | { readonly kind: 'too-few-value-series'; readonly valueSeriesCount: number }
  | { readonly kind: 'too-many-value-series'; readonly valueSeriesCount: number }

/**
 * The scatter the selected series `ids` make, in selection order.
 *
 * @remarks
 * Only point and level series count, each by the kind its source reads its id
 * as (`seriesKindOfId`) — the counting `selectionCapsOf` does — so a series
 * whose row has not loaded yet still counts. Span lanes have no value to
 * plot, so a lane beside two value series leaves the scatter drawable.
 */
const scatterAxesOf = (ids: readonly string[]): ScatterAxes => {
  const valueSeriesIds = ids.filter((id) => {
    const kind = seriesKindOfId(id)
    return kind !== null && kind !== 'spans'
  })
  const [xSeriesId, ySeriesId] = valueSeriesIds
  const valueSeriesCount = valueSeriesIds.length
  if (valueSeriesCount > SCATTER_SERIES_COUNT) {
    return { kind: 'too-many-value-series', valueSeriesCount }
  }
  if (xSeriesId === undefined || ySeriesId === undefined) {
    return { kind: 'too-few-value-series', valueSeriesCount }
  }
  return { kind: 'paired', xSeriesId, ySeriesId }
}

/**
 * The view the page shows: the one the selection asks for, except that a
 * scatter the selection cannot make shows the chart.
 *
 * @remarks
 * The selection keeps asking for the scatter, so selecting two value series
 * again brings it back without the reader picking it a second time.
 */
const shownViewOf = (view: PlotView, scatterAxes: ScatterAxes): PlotView =>
  view === 'scatter' && scatterAxes.kind !== 'paired' ? 'chart' : view

export type { PlotView, ScatterAxes }
export { PLOT_VIEWS, isPlotView, scatterAxesOf, shownViewOf }
