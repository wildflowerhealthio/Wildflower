/**
 * The health viewer's medication source: FHIR R4 `MedicationRequest`s read
 * through `medication-core`'s dose regimens into `health-viewer-fundamentals`
 * level series, exported as one `SeriesSource` value (`medicationSource`) —
 * the reading, the `m:` series-id grammar, and the Medications catalogue
 * group.
 *
 * @packageDocumentation
 */
export { medicationSource } from './source.ts'

export type { MedicationSeriesKey } from './medication-series-key.ts'
export type { DoseLevel, MedicationSeries } from './medication-series.ts'
export { doseRegimensToSeries } from './medication-series.ts'
