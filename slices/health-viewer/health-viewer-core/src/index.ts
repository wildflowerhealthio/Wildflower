/**
 * The pure logic behind the synthesized health viewer: the plottable series
 * model, the FHIR R4 `Observation` → series adapter, axis assignment and value
 * domains, the x-axis range presets, the catalogue panel's grouping and
 * search, the URL codec a shared link round-trips through, and the crosshair
 * lookup. No DOM, no React, no platform imports — the React layer renders what
 * this package computes.
 *
 * The dose-regimen → {@link MedicationSeries} mapping is not here: the segment
 * shape it produces is defined in this package so the mapping only has to
 * build it.
 *
 * @packageDocumentation
 */
export type {
  DoseSegment,
  MedicationSeries,
  MedicationSeriesKey,
  ObservationSeries,
  ObservationSeriesKey,
  Series,
  SeriesKey,
  SeriesKind,
  SeriesPoint,
} from './series.ts'
export { isMedicationSeries, isObservationSeries, parseSeriesId, seriesId } from './series.ts'

export type { ObservationResource, ObservationSeriesResult } from './observation-series.ts'
export { EXCLUDED_STATUSES, LOINC_SYSTEM, observationsToSeries } from './observation-series.ts'

export type { AxisSlot, Domain } from './axis-assignment.ts'
export {
  AXIS_CAP,
  assignAxes,
  denormalise,
  domainFor,
  niceDomain,
  normalise,
  ticksFor,
} from './axis-assignment.ts'

export type { RangePreset, TimeDomain } from './time-range.ts'
export {
  PRESET_LOOKBACK,
  RANGE_PRESETS,
  isRangePreset,
  pointsWithin,
  xDomain,
} from './time-range.ts'

export type { CatalogGroup, CatalogRow } from './catalog.ts'
export {
  CATEGORY_ORDER,
  GROUP_LABELS,
  MEDICATIONS_GROUP,
  OTHER_GROUP,
  groupForPanel,
  matchesSearch,
  normaliseForSearch,
} from './catalog.ts'

export type { Selection } from './selection-url.ts'
export {
  DEFAULT_RANGE,
  PATIENT_PARAM,
  RANGE_PARAM,
  SERIES_PARAM,
  decodeSelection,
  encodeSelection,
} from './selection-url.ts'

export type { ValueAt } from './values-at.ts'
export { pointAt, segmentAt, valueAt } from './values-at.ts'
