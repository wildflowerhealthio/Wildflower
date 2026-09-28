/**
 * The health viewer's observation source: FHIR R4 `Observation`s read into
 * `health-viewer-fundamentals` point series, exported as one `SeriesSource`
 * value (`observationSource`) — the reading, the `o:` series-id grammar, and
 * the catalogue grouping by `Observation.category`.
 *
 * @packageDocumentation
 */
export { observationSource } from './source.ts'

export type { ObservationSeriesKey } from './observation-series-key.ts'
export type { ObservationResource, ObservationSeries } from './observation-series.ts'
export { EXCLUDED_STATUSES, LOINC_SYSTEM } from './observation-series.ts'
