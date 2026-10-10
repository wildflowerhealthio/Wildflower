/**
 * The health viewer's assembly: the closed list of domain sources a patient's
 * record is read through, the catalogue panel's grouping and search, the
 * x-axis range presets, and the URL codec a shared link round-trips through.
 * No DOM, no React, no platform imports.
 *
 * The chart's vocabulary and math — series, levels, value axes, the
 * crosshair — are `health-viewer-fundamentals`'; what a record means is each
 * domain package's (`health-viewer-observations`,
 * `health-viewer-medications`).
 *
 * @packageDocumentation
 */
export type { FiledSeries, RecordReading, RecordResources } from './series-sources.ts'
export { CATALOG_GROUPS, SERIES_SOURCES, isKnownSeriesId, readRecord } from './series-sources.ts'

export type { RangePreset } from './time-range.ts'
export { PRESET_LOOKBACK, RANGE_PRESETS, isRangePreset, xDomain } from './time-range.ts'

export type { CatalogGroup, CatalogRow } from './catalog.ts'
export { groupForPanel, matchesSearch, normaliseForSearch } from './catalog.ts'

export type { Selection } from './selection-url.ts'
export {
  DEFAULT_RANGE,
  RANGE_PARAM,
  SERIES_PARAM,
  decodeSelection,
  encodeSelection,
  withSelection,
} from './selection-url.ts'
