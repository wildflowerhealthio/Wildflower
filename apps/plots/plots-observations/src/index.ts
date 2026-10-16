/**
 * Plots' observation source: FHIR R4 `Observation`s read into
 * `plots-fundamentals` point series and span series, exported as one `SeriesSource`
 * value (`observationSource`) — the reading, the `o:` series-id grammar, and
 * the catalogue grouping by `Observation.category`.
 *
 * @packageDocumentation
 */
export { observationSource } from './source.ts'

export type {
  ObservationPointSeriesKey,
  ObservationSeriesKey,
  ObservationSpanSeriesKey,
} from './observation-series-key.ts'
export type {
  ObservationPointSeries,
  ObservationResource,
  ObservationSeries,
  ObservationSpanSeries,
} from './observation-series.ts'
export { EXCLUDED_STATUSES, LOINC_SYSTEM } from './observation-series.ts'
