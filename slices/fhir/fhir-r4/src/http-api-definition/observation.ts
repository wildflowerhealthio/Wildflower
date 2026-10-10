import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { Observation } from '../resources/observation/index.ts'
import { SearchParams as ObservationSearchParams } from '../resources/observation/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'Observation',
  Observation.Schema,
  ObservationSearchParams
)

export { httpApiGroup }
