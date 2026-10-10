import { SeriesSource } from '@wildflowerhealthio/health-viewer-fundamentals'
import type { MedicationRequestWithId } from '@wildflowerhealthio/medication-core/fhir'

import { MEDICATION_GROUPS, medicationGroupIdOf } from './medication-groups.ts'
import {
  MEDICATION_ID_PREFIX,
  type MedicationSeriesKey,
  medicationSeriesIdOf,
  parseMedicationSeriesId,
} from './medication-series-key.ts'
import { type MedicationSeries, medicationRequestsToSeries } from './medication-series.ts'

/**
 * The medication source as one value — the package's whole public surface
 * apart from its types: FHIR R4 `MedicationRequest`s read into dose level
 * series, the `m:` id grammar, and the Medications catalogue group.
 */
const medicationSource: SeriesSource.SeriesSource<
  readonly MedicationRequestWithId[],
  MedicationSeriesKey,
  MedicationSeries
> = SeriesSource.make({
  name: 'medications',
  idPrefix: MEDICATION_ID_PREFIX,
  groups: MEDICATION_GROUPS,
  read: medicationRequestsToSeries,
  seriesIdOf: medicationSeriesIdOf,
  parseSeriesId: parseMedicationSeriesId,
  groupIdOf: medicationGroupIdOf,
})

export { medicationSource }
