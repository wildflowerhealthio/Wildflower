import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { MedicationRequest } from '../resources/medication-request/index.ts'
import { SearchParams as MedicationRequestSearchParams } from '../resources/medication-request/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'MedicationRequest',
  MedicationRequest.Schema,
  MedicationRequestSearchParams
)

export { httpApiGroup }
