import { SeriesSource } from 'health-viewer-fundamentals'

import { OBSERVATION_GROUPS, observationGroupIdOf } from './observation-groups.ts'
import {
  OBSERVATION_ID_PREFIX,
  type ObservationSeriesKey,
  observationSeriesIdOf,
  parseObservationSeriesId,
} from './observation-series-key.ts'
import {
  type ObservationResource,
  type ObservationSeries,
  observationsToSeries,
} from './observation-series.ts'

/**
 * The observation source as one value — the package's whole public surface
 * apart from its types: FHIR R4 `Observation`s read into point series, the
 * `o:` id grammar, and the catalogue grouping by `Observation.category`.
 */
const observationSource: SeriesSource.SeriesSource<
  readonly ObservationResource[],
  ObservationSeriesKey,
  ObservationSeries
> = SeriesSource.make({
  name: 'observations',
  idPrefix: OBSERVATION_ID_PREFIX,
  groups: OBSERVATION_GROUPS,
  read: observationsToSeries,
  seriesIdOf: observationSeriesIdOf,
  parseSeriesId: parseObservationSeriesId,
  groupIdOf: observationGroupIdOf,
})

export { observationSource }
