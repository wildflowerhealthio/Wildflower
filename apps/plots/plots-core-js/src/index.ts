/**
 * Plots' assembly: the closed list of domain sources a patient's
 * record is read through, the catalogue panel's grouping and search, the
 * x-axis range presets, the views the selection is shown in, and the URL
 * codec a shared link round-trips through.
 * No DOM, no React, no platform imports.
 *
 * The chart's vocabulary and math — series, levels, value axes, the
 * crosshair — are `plots-fundamentals`'; what a record means is each
 * domain package's (`plots-observations`,
 * `plots-medications`).
 *
 * @packageDocumentation
 */
export type { FiledSeries, RecordReading, RecordResources } from './series-sources.ts'
export { CATALOG_GROUPS, SERIES_SOURCES, readRecord, seriesKindOfId } from './series-sources.ts'

export type { RangePreset } from './time-range.ts'
export { PRESET_LOOKBACK, RANGE_PRESETS, isRangePreset, xDomain } from './time-range.ts'

export type { PlotView, ScatterAxes } from './plot-view.ts'
export { PLOT_VIEWS, isPlotView, scatterAxesOf, shownViewOf } from './plot-view.ts'

export type { CatalogGroup, CatalogRow } from './catalog.ts'
export { groupForPanel, matchesSearch, normaliseForSearch } from './catalog.ts'

export type { Selection, SelectionCaps } from './selection-url.ts'
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
} from './selection-url.ts'
